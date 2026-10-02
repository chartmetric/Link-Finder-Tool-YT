import { clickHouseJson } from "./clickhouse-profiles";

// Tier assignments have multiple historical rows. Each musician belongs only
// to its latest global tier, not every tier it has ever occupied.
const cohort = `
  tier_assignments AS (
    SELECT profile, argMax(tier, tuple(computed_at, updated_at)) AS tier
    FROM new_vertical.l_profile_tier
    WHERE profile_type = 'musician' AND grain = 'global'
    GROUP BY profile
  ),
  musicians AS (
    SELECT profile, tier FROM tier_assignments
    WHERE tier BETWEEN 1 AND 3
      AND profile IN (SELECT id FROM new_vertical.profile WHERE deleted_at IS NULL)
  )
`;

function normalizedUrl(column: string) {
  return `lowerUTF8(trimRight(replaceRegexpOne(
    replaceRegexpOne(ifNull(${column}, ''), '^https?://(www[.]|m[.])?', ''),
    '[?#].*$', ''), '/'))`;
}

type TierRow = { tier: number; profiles: number | string; with_llm_links: number | string };
type MatchRow = { tier: number; profiles: number | string };

async function readMusicianCoverage() {
  const [counts, history] = await Promise.all([
    clickHouseJson<TierRow>(`
      WITH ${cohort}
      SELECT tier, count() AS profiles,
        countIf(profile IN (
          SELECT profile_id FROM new_vertical.profile_websearch_llm
          WHERE arrayExists(link -> notEmpty(trim(link)), platform_links)
        )) AS with_llm_links
      FROM musicians
      GROUP BY tier ORDER BY tier
      FORMAT JSON
    `, {}, 15_000),
    clickHouseJson<{ reference: string }>(`
      SELECT DISTINCT ${normalizedUrl("known_profile_url")} AS reference
      FROM poc_new_verticals.profile_search_history
      WHERE length(JSONExtractArrayRaw(result_json, 'profiles')) > 0
      FORMAT JSON
    `, {}, 5_000),
  ]);

  // History has no catalog profile ID. Match the trusted reference URL against
  // existing account/profile links; names are never used as an identity join.
  const references = history.data.map(row => row.reference).filter(Boolean);
  const matches = references.length ? await clickHouseJson<MatchRow>(`
    WITH ${cohort},
    known_urls AS (
      SELECT arrayJoin(JSONExtract({references:String}, 'Array(String)')) AS reference
    ),
    account_links AS (
      SELECT profile_id, account_id
      FROM new_vertical.l_profile_account
      WHERE disconnected_at IS NULL
        AND profile_id IN (SELECT profile FROM musicians)
    ),
    history_profiles AS (
      SELECT profile_id
      FROM account_links
      WHERE account_id IN (
        SELECT id FROM new_vertical.account
        WHERE id IN (SELECT account_id FROM account_links)
          AND ${normalizedUrl("account_url")} IN (SELECT reference FROM known_urls)
      )
      UNION DISTINCT
      SELECT profile_id FROM new_vertical.profile_links
      WHERE profile_id IN (SELECT profile FROM musicians)
        AND active = 'true'
        AND ${normalizedUrl("url")} IN (SELECT reference FROM known_urls)
    )
    SELECT tier, count() AS profiles FROM musicians
    WHERE profile IN (SELECT profile_id FROM history_profiles)
    GROUP BY tier ORDER BY tier
    FORMAT JSON
  `, { references: JSON.stringify(references) }, 15_000) : { data: [] };

  const tiers = [1, 2, 3].map(tier => {
    const row = counts.data.find(item => Number(item.tier) === tier);
    const match = matches.data.find(item => Number(item.tier) === tier);
    return {
      tier,
      profiles: Number(row?.profiles ?? 0),
      withLlmLinks: Number(row?.with_llm_links ?? 0),
      withInvestigationLinks: Number(match?.profiles ?? 0),
    };
  });
  return {
    profiles: tiers.reduce((sum, tier) => sum + tier.profiles, 0),
    withLlmLinks: tiers.reduce((sum, tier) => sum + tier.withLlmLinks, 0),
    withInvestigationLinks: tiers.reduce((sum, tier) => sum + tier.withInvestigationLinks, 0),
    tiers,
    generatedAt: new Date(),
  };
}

type Coverage = Awaited<ReturnType<typeof readMusicianCoverage>>;
let cached: { value: Coverage; expiresAt: number } | undefined;
let inFlight: Promise<Coverage> | undefined;
let revision = 0;

export function invalidateMusicianCoverage() {
  revision++;
  cached = undefined;
  inFlight = undefined;
}

export async function getMusicianCoverage(): Promise<Coverage> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (inFlight) return inFlight;
  const currentRevision = revision;
  const request = readMusicianCoverage().then(value => {
    if (revision === currentRevision) cached = { value, expiresAt: Date.now() + 60_000 };
    return value;
  }).finally(() => {
    if (inFlight === request) inFlight = undefined;
  });
  inFlight = request;
  return request;
}