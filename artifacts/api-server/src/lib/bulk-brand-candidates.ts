import { ListBulkBrandCandidatesQueryParams, type BulkBrandCandidate, type BulkProfileType, type BulkProfileScopeInput } from "@workspace/api-zod";
import { clickHouseJson } from "./clickhouse-profiles";
import { parseKnownProfileUrl } from "./musician-search";
import { candidateAccountIds, readAttemptedBulkCandidates } from "./bulk-run-store";
export { paidProfilesSql } from "./bulk-run-store";

import { catalogProfileType, MAX_BULK_BATCH } from "./bulk-profile-scopes";
export { MAX_BULK_BATCH } from "./bulk-profile-scopes";

/** Catalog reads only. Filter current values before limiting the profile page.
 * Optional filter CTEs never embed/repeat the full current-profile aggregation. */
export function eligibleBrandSql(selectedIds = false, bounded = false, filters: { search?: boolean; tier?: boolean } = {}) {
  return `
    WITH ${filters.search ? `
    matching_names AS (
      SELECT id, argMax(tuple(name), updated_at) AS name_data
      FROM new_vertical.profile WHERE id IN (
        SELECT id FROM new_vertical.profile
        WHERE positionCaseInsensitiveUTF8(ifNull(name, ''), {search:String}) > 0
      )
      GROUP BY id HAVING positionCaseInsensitiveUTF8(ifNull(tupleElement(name_data, 1), ''), {search:String}) > 0
    ), matching_accounts AS (
      SELECT id, argMax(tuple(handle, is_active), modified_at) AS account
      FROM new_vertical.account WHERE id IN (
        SELECT id FROM new_vertical.account
        WHERE positionCaseInsensitiveUTF8(ifNull(handle, ''), {search:String}) > 0
      )
      GROUP BY id HAVING tupleElement(account, 2) = 1
        AND positionCaseInsensitiveUTF8(ifNull(tupleElement(account, 1), ''), {search:String}) > 0
    ), matching_links AS (
      SELECT id, argMax(tuple(profile_id, account_id, disconnected_at), modified_at) AS link
      FROM new_vertical.l_profile_account WHERE id IN (
        SELECT id FROM new_vertical.l_profile_account WHERE account_id IN (SELECT id FROM matching_accounts)
      )
      GROUP BY id HAVING tupleElement(link, 3) IS NULL
        AND tupleElement(link, 2) IN (SELECT id FROM matching_accounts)
    ),` : ""}
    ${filters.tier ? `
    matching_tiers AS (
      SELECT profile, argMax(tuple(tier, tier_rank), tuple(computed_at, updated_at)) AS assignment
      FROM new_vertical.l_profile_tier
      WHERE profile_type = {profileType:String} AND grain = 'global'
      GROUP BY profile HAVING tupleElement(assignment, 1) = {tier:UInt8}
    ),` : ""}
    ${!selectedIds ? `
    source_ids AS (
      SELECT DISTINCT id FROM new_vertical.profile
      WHERE id > {afterId:UInt64} ${bounded ? "AND id <= {upperId:UInt64}" : ""}
        AND (profile_type = {profileType:String} OR has(profile_types, {profileType:String}))
        ${filters.search ? `AND id IN (
          SELECT id FROM matching_names
          UNION DISTINCT SELECT tupleElement(link, 1) FROM matching_links
        )` : ""}
        ${filters.tier ? "AND id IN (SELECT profile FROM matching_tiers)" : ""}
      ORDER BY id ASC LIMIT {rowLimit:UInt32}
    ),` : ""}
    current_profiles AS (
      SELECT id, argMax(tuple(name, deleted_at, profile_type, profile_types), updated_at) AS data
      FROM new_vertical.profile
      WHERE ${selectedIds ? "id IN {ids:Array(UInt64)}" : "id IN (SELECT id FROM source_ids)"}
      ${bounded ? "AND id <= {upperId:UInt64}" : ""}
      ${filters.search ? `AND id IN (
        SELECT id FROM matching_names
        UNION DISTINCT SELECT tupleElement(link, 1) FROM matching_links
      )` : ""}
      GROUP BY id HAVING tupleElement(data, 2) IS NULL
        AND (tupleElement(data, 3) = {profileType:String}
          OR has(tupleElement(data, 4), {profileType:String}))
        ${filters.tier ? "AND id IN (SELECT profile FROM matching_tiers)" : ""}
      ORDER BY id ASC LIMIT {rowLimit:UInt32}
    )
    SELECT id AS profileId, tupleElement(data, 1) AS profileName,
      toUInt64(0) AS scanAfterId, toUInt64(0) AS scanCount
    FROM current_profiles
    ${!selectedIds ? `
    UNION ALL
    SELECT toUInt64(0) AS profileId, '' AS profileName, max(id) AS scanAfterId, count() AS scanCount
    FROM source_ids` : ""}
    ORDER BY profileId ASC FORMAT JSON
  `;
}

/** Profile IDs are bounded by the preceding page, so account joins never rescan
 * the entire profile catalog through repeated ClickHouse CTE expansion. */
export function profileAccountDetailsSql() {
  return `
    WITH current_profiles AS (SELECT arrayJoin({ids:Array(UInt64)}) AS id),
    tiers AS (
      SELECT profile, argMax(tuple(tier, tier_rank), tuple(computed_at, updated_at)) AS assignment
      FROM new_vertical.l_profile_tier
      WHERE profile_type = {profileType:String} AND grain = 'global'
        AND profile IN (SELECT id FROM current_profiles)
      GROUP BY profile
    ), current_relationships AS (
      SELECT id, argMax(tuple(profile_id, account_id, disconnected_at), modified_at) AS link
      FROM new_vertical.l_profile_account WHERE id IN (
        SELECT id FROM new_vertical.l_profile_account WHERE profile_id IN (SELECT id FROM current_profiles)
      )
      GROUP BY id HAVING tupleElement(link, 3) IS NULL
        AND tupleElement(link, 1) IN (SELECT id FROM current_profiles)
    ), current_accounts AS (
      SELECT id, argMax(tuple(platform, handle, account_url, is_active), modified_at) AS account
      FROM new_vertical.account WHERE id IN (SELECT tupleElement(link, 2) FROM current_relationships)
      GROUP BY id HAVING tupleElement(account, 4) = 1
    ), linked_accounts AS (
      SELECT tupleElement(r.link, 1) AS profile_id,
        arraySort(x -> x.1, groupUniqArray(tuple(toString(a.id), tupleElement(a.account, 1),
          ifNull(tupleElement(a.account, 2), ''), ifNull(tupleElement(a.account, 3), '')))) AS accounts
      FROM current_relationships r
      INNER JOIN current_accounts a ON a.id = tupleElement(r.link, 2)
      GROUP BY profile_id
    )
    SELECT p.id AS profileId,
      if(t.profile = 0, NULL, tupleElement(t.assignment, 1)) AS tier,
      if(t.profile = 0, NULL, tupleElement(t.assignment, 2)) AS tierRank,
      a.accounts AS accounts
    FROM current_profiles p
    LEFT JOIN tiers t ON t.profile = p.id
    LEFT JOIN linked_accounts a ON a.profile_id = p.id
    ORDER BY p.id ASC
    FORMAT JSON
  `;
}

type CatalogRow = { profileId: number; profileName: string; tier: number | null; tierRank: number | null; accounts: [string, string, string, string][] };

export function catalogCandidate(row: CatalogRow, profileType: BulkProfileType): BulkBrandCandidate {
  const accounts = (row.accounts ?? []).map(([accountId, platform, handle, url]) => ({ accountId, platform, handle, url }));
  const usable = accounts.map(account => ({ account, parsed: parseKnownProfileUrl(account.url) })).filter(value => value.parsed);
  usable.sort((a, b) => Number(a.parsed!.platform === "web") - Number(b.parsed!.platform === "web"));
  const seed = usable[0];
  return {
    profileId: Number(row.profileId), profileName: row.profileName, profileType,
    tier: row.tier === null ? null : Number(row.tier), tierRank: row.tierRank === null ? null : Number(row.tierRank),
    accountId: seed?.account.accountId ?? "", platform: seed?.account.platform ?? "",
    handle: seed?.account.handle ?? "", url: seed?.parsed?.url ?? "",
    accounts, accountCount: accounts.length, canInvestigate: Boolean(seed),
    ...(!seed ? { investigationBlockedReason: accounts.length
      ? "No usable existing profile link. Discovery requires a valid public reference URL."
      : "No active linked account. An existing profile link is required for discovery." } : {}),
  };
}

export async function listEligibleBrands(input: { limit: number; afterId?: number; profileIds?: number[]; profileType?: BulkProfileType; eligibleOnly?: boolean; maxProfileId?: number; search?: string; tier?: number; remaining?: boolean }, readCatalog = clickHouseJson) {
  // Guard internal callers as well as the HTTP boundary before binding UInts.
  // Continuous selection already uses bounded 250-row internal reads. The HTTP
  // contract remains capped at 25; only a frozen source ceiling permits more.
  const filters = ListBulkBrandCandidatesQueryParams.parse({ ...input, limit: Math.min(input.limit, MAX_BULK_BATCH) });
  if (!Number.isSafeInteger(input.limit) || input.limit > (input.maxProfileId !== undefined ? 250 : MAX_BULK_BATCH)
    || !Number.isSafeInteger(input.afterId ?? 0)
    || (input.maxProfileId !== undefined && (!Number.isSafeInteger(input.maxProfileId) || input.maxProfileId < 0))
    || (input.profileIds && (!input.profileIds.length || input.profileIds.length > MAX_BULK_BATCH
      || input.profileIds.some(id => !Number.isSafeInteger(id) || id < 1)))) {
    throw new Error("Invalid candidate page bounds or profile IDs.");
  }
  const profileType = filters.profileType ?? "brand";
  const search = (filters.search ?? "").trim().replace(/^@/, "").trim();
  const collected: BulkBrandCandidate[] = [];
  let afterId = input.afterId ?? 0;
  for (let scan = 0; scan < 4; scan++) {
    const rowLimit = input.eligibleOnly && !input.profileIds ? 250 : input.limit + 1;
    const rows = await readCatalog<Pick<CatalogRow, "profileId" | "profileName"> & { scanAfterId?: number; scanCount?: number }>(eligibleBrandSql(Boolean(input.profileIds), input.maxProfileId !== undefined, { search: Boolean(search), tier: filters.tier !== undefined }), {
      ids: JSON.stringify(input.profileIds ?? []), profileType: catalogProfileType(profileType),
      afterId: String(afterId), rowLimit: String(rowLimit),
      search, tier: String(filters.tier ?? 0),
      ...(input.maxProfileId !== undefined ? { upperId: String(input.maxProfileId) } : {}),
    }, 20_000, "candidate_ids");
    // The sentinel preserves scan progress even when every historical candidate
    // in a page is now deleted or belongs to a different type.
    const scanState = rows.data.find(row => Number(row.profileId) === 0 && row.scanCount !== undefined);
    const profileRows = rows.data.filter(row => Number(row.profileId) > 0);
    const details = profileRows.length ? await readCatalog<Omit<CatalogRow, "profileName">>(profileAccountDetailsSql(), {
      ids: JSON.stringify(profileRows.map(row => Number(row.profileId))), profileType: catalogProfileType(profileType),
    }, 20_000, "account_enrichment") : { data: [] };
    const byId = new Map(details.data.map(row => [Number(row.profileId), row]));
    const candidates = profileRows.map(row => catalogCandidate({
      ...row, tier: null, tierRank: null, accounts: [], ...byId.get(Number(row.profileId)),
    }, profileType));
    const attempted = input.remaining ? await readAttemptedBulkCandidates(candidates, readCatalog) : new Set<number>();
    collected.push(...candidates.filter(row => (!input.eligibleOnly || row.canInvestigate) && !attempted.has(row.profileId)));
    const more = !input.profileIds && Number(scanState?.scanCount ?? profileRows.length) === rowLimit;
    afterId = Math.max(afterId, Number(scanState?.scanAfterId ?? profileRows.at(-1)?.profileId ?? afterId));
    if (collected.length > input.limit || !more || !input.eligibleOnly || input.remaining) {
      const page = collected.slice(0, input.limit);
      return {
        profiles: page, hasMore: collected.length > input.limit || more,
        nextAfterId: Number(collected.length > input.limit ? page.at(-1)?.profileId : afterId), maxBatchSize: MAX_BULK_BATCH,
      };
    }
  }
  throw new Error("Runnable selection reached its bounded read limit. Select linked profiles manually; no paid run was started.");
}

/** Bounded, deterministic auto-selection; never pay twice for the same catalog
 * profile when it appears under more than one requested type. */
export async function selectBulkScopes(scopes: BulkProfileScopeInput[], fetchPage = listEligibleBrands, mode: "remaining" | "rerun" = "remaining", maxProfileId?: number, progress?: (selected: BulkBrandCandidate[]) => Promise<void>) {
  const selected: BulkBrandCandidate[] = [];
  const seen = new Set<number>();
  const accounts = new Set<string>();
  // Read in a fixed order so a retried selection has a stable duplicate owner.
  for (const scope of scopes) {
    let added = 0;
    let afterId = 0;
    while (added < scope.limit) {
      const page = await fetchPage({ limit: Math.min(maxProfileId !== undefined ? 250 : MAX_BULK_BATCH, scope.limit - added), profileType: scope.profileType, eligibleOnly: true, afterId, remaining: mode === "remaining", maxProfileId });
      for (const candidate of page.profiles) {
        const ids = candidateAccountIds(candidate);
        if (seen.has(candidate.profileId) || ids.some(id => accounts.has(id))) continue;
        seen.add(candidate.profileId);
        ids.forEach(id => accounts.add(id));
        selected.push(candidate);
        if (++added >= scope.limit) break;
      }
      await progress?.(selected);
      if (!page.hasMore) break;
      if (page.nextAfterId <= afterId) throw new Error("Catalog selection did not advance. No paid queue was started.");
      afterId = page.nextAfterId;
    }
  }
  return selected;
}
