import type { BulkBrandCandidate, BulkProfileType, BulkProfileScopeInput } from "@workspace/api-zod";
import { clickHouseJson } from "./clickhouse-profiles";
import { parseKnownProfileUrl } from "./musician-search";

import { catalogProfileType, MAX_BULK_BATCH } from "./bulk-profile-scopes";
export { MAX_BULK_BATCH } from "./bulk-profile-scopes";

/** Catalog reads only. Latest global tier for the bound type; all tiers. */
export function eligibleBrandSql(selectedIds = false) {
  return `
    WITH brands AS (
      SELECT profile,
        argMax(tuple(tier, tier_rank), tuple(computed_at, updated_at)) AS assignment
      FROM new_vertical.l_profile_tier
      WHERE profile_type = {profileType:String} AND grain = 'global'
      ${selectedIds ? "AND profile IN {ids:Array(UInt64)}" : "AND profile > {afterId:UInt64}"}
      GROUP BY profile
    ), current_profiles AS (
      SELECT id, argMax(tuple(name, deleted_at), updated_at) AS data
      FROM new_vertical.profile WHERE id IN (SELECT profile FROM brands)
      GROUP BY id HAVING tupleElement(data, 2) IS NULL
    ), current_relationships AS (
      SELECT id, argMax(tuple(profile_id, account_id, disconnected_at), modified_at) AS link
      FROM new_vertical.l_profile_account WHERE profile_id IN (SELECT profile FROM brands)
      GROUP BY id HAVING tupleElement(link, 3) IS NULL
    ), current_accounts AS (
      SELECT id, argMax(tuple(platform, handle, account_url, is_active), modified_at) AS account
      FROM new_vertical.account WHERE id IN (SELECT tupleElement(link, 2) FROM current_relationships)
      GROUP BY id HAVING tupleElement(account, 4) = 1
    ), single_accounts AS (
      SELECT tupleElement(r.link, 1) AS profile_id, any(a.id) AS account_id
      FROM current_relationships r
      INNER JOIN current_accounts a ON a.id = tupleElement(r.link, 2)
      GROUP BY profile_id HAVING uniqExact(a.id) = 1
    )
    SELECT p.id AS profileId, tupleElement(p.data, 1) AS profileName,
      tupleElement(b.assignment, 1) AS tier,
      tupleElement(b.assignment, 2) AS tierRank,
      toString(a.id) AS accountId, tupleElement(a.account, 1) AS platform,
      tupleElement(a.account, 2) AS handle, tupleElement(a.account, 3) AS url
    FROM single_accounts s
    INNER JOIN brands b ON b.profile = s.profile_id
    INNER JOIN current_profiles p ON p.id = s.profile_id
    INNER JOIN current_accounts a ON a.id = s.account_id
    WHERE tupleElement(a.account, 3) IS NOT NULL
      AND notEmpty(trim(tupleElement(a.account, 3)))
    ORDER BY p.id ASC LIMIT {rowLimit:UInt32}
    FORMAT JSON
  `;
}

export async function listEligibleBrands(input: { limit: number; afterId?: number; profileIds?: number[]; profileType?: BulkProfileType }) {
  const profileType = input.profileType ?? "brand";
  const rows = await clickHouseJson<BulkBrandCandidate>(eligibleBrandSql(Boolean(input.profileIds)), {
    ids: `[${(input.profileIds ?? []).join(",")}]`,
    profileType: catalogProfileType(profileType),
    afterId: String(input.afterId ?? 0),
    rowLimit: String(input.profileIds ? MAX_BULK_BATCH : input.limit + 1),
  }, 20_000);
  const page = rows.data.slice(0, input.limit);
  return {
    profiles: page.map(row => ({
      ...row, profileType, profileId: Number(row.profileId), tier: Number(row.tier), tierRank: Number(row.tierRank),
      url: parseKnownProfileUrl(row.url)?.url ?? row.url,
    })),
    hasMore: rows.data.length > input.limit,
    nextAfterId: Number(page.at(-1)?.profileId ?? input.afterId ?? 0),
    maxBatchSize: MAX_BULK_BATCH,
  };
}

/** Bounded, deterministic auto-selection; never pay twice for the same catalog
 * profile when it appears under more than one requested type. */
export async function selectBulkScopes(scopes: BulkProfileScopeInput[], fetchPage = listEligibleBrands) {
  const selected: BulkBrandCandidate[] = [];
  const seen = new Set<number>();
  // Read in a fixed order so a retried selection has a stable duplicate owner.
  for (const scope of scopes) {
    const page = await fetchPage({ limit: MAX_BULK_BATCH, profileType: scope.profileType });
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
