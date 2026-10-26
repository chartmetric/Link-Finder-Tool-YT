import type { BulkBrandCandidate, BulkProfileType, BulkProfileScopeInput } from "@workspace/api-zod";
import { clickHouseJson } from "./clickhouse-profiles";
import { parseKnownProfileUrl } from "./musician-search";

import { catalogProfileType, MAX_BULK_BATCH } from "./bulk-profile-scopes";
export { MAX_BULK_BATCH } from "./bulk-profile-scopes";

/** Catalog reads only. Current profile classification, including unranked profiles. */
export function eligibleBrandSql(selectedIds = false) {
  return `
    WITH current_profiles AS (
      SELECT id, argMax(tuple(name, deleted_at, profile_type, profile_types), updated_at) AS data
      FROM new_vertical.profile
      WHERE ${selectedIds ? "id IN {ids:Array(UInt64)}" : "id > {afterId:UInt64}"}
      GROUP BY id HAVING tupleElement(data, 2) IS NULL
        AND (tupleElement(data, 3) = {profileType:String}
          OR has(tupleElement(data, 4), {profileType:String}))
      ORDER BY id ASC LIMIT {rowLimit:UInt32}
    )
    SELECT id AS profileId, tupleElement(data, 1) AS profileName
    FROM current_profiles ORDER BY id ASC FORMAT JSON
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

export async function listEligibleBrands(input: { limit: number; afterId?: number; profileIds?: number[]; profileType?: BulkProfileType; eligibleOnly?: boolean }) {
  const profileType = input.profileType ?? "brand";
  const collected: BulkBrandCandidate[] = [];
  let afterId = input.afterId ?? 0;
  for (let scan = 0; scan < 4; scan++) {
    const rowLimit = input.eligibleOnly && !input.profileIds ? 250 : input.limit + 1;
    const rows = await clickHouseJson<Pick<CatalogRow, "profileId" | "profileName">>(eligibleBrandSql(Boolean(input.profileIds)), {
      ids: JSON.stringify(input.profileIds ?? []), profileType: catalogProfileType(profileType),
      afterId: String(afterId), rowLimit: String(rowLimit),
    }, 20_000);
    const details = rows.data.length ? await clickHouseJson<Omit<CatalogRow, "profileName">>(profileAccountDetailsSql(), {
      ids: JSON.stringify(rows.data.map(row => Number(row.profileId))), profileType: catalogProfileType(profileType),
    }, 20_000) : { data: [] };
    const byId = new Map(details.data.map(row => [Number(row.profileId), row]));
    collected.push(...rows.data.map(row => catalogCandidate({
      ...row, tier: null, tierRank: null, accounts: [], ...byId.get(Number(row.profileId)),
    }, profileType)).filter(row => !input.eligibleOnly || row.canInvestigate));
    const more = !input.profileIds && rows.data.length === rowLimit;
    afterId = Number(rows.data.at(-1)?.profileId ?? afterId);
    if (collected.length > input.limit || !more || !input.eligibleOnly) {
      const page = collected.slice(0, input.limit);
      return {
        profiles: page, hasMore: collected.length > input.limit || more,
        nextAfterId: Number(page.at(-1)?.profileId ?? afterId), maxBatchSize: MAX_BULK_BATCH,
      };
    }
  }
  throw new Error("Runnable selection reached its bounded read limit. Select linked profiles manually; no paid run was started.");
}

/** Bounded, deterministic auto-selection; never pay twice for the same catalog
 * profile when it appears under more than one requested type. */
export async function selectBulkScopes(scopes: BulkProfileScopeInput[], fetchPage = listEligibleBrands) {
  const selected: BulkBrandCandidate[] = [];
  const seen = new Set<number>();
  // Read in a fixed order so a retried selection has a stable duplicate owner.
  for (const scope of scopes) {
    const page = await fetchPage({ limit: MAX_BULK_BATCH, profileType: scope.profileType, eligibleOnly: true });
    let added = 0;
    for (const candidate of page.profiles) {
      if (seen.has(candidate.profileId)) continue;
      seen.add(candidate.profileId);
      selected.push(candidate);
      if (++added >= scope.limit) break;
    }
  }
  return selected;
}
