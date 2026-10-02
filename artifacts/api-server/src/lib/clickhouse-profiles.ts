type ClickHouseProfileRow = {
  profile_id: number;
  profile_name: string;
  profile_types: string;
  tier: number;
  tier_rank: number;
};

type ProfileAccountLinkRow = {
  profile_id: number;
  account_id: number;
};

type AccountRow = {
  id: number;
  platform: string;
  handle: string;
  account_url: string;
  source: string;
};

type InstagramFollowerRow = {
  account_id: number;
  followers: number;
};

type ClickHouseResponse<T> = {
  data: T[];
};

export type ExistingProfile = {
  profileId: number;
  profileName: string;
  profileTypes: string;
  tier: number;
  tierRank: number;
  instagramFollowers: number | null;
  accounts: ExistingProfileAccount[];
};

type ExistingProfileAccount = {
  platform: string;
  handle: string;
  accountUrl: string;
  source: string;
};

type ApprovedSuggestion = {
  platform: string;
  handle: string;
  accountUrl: string;
  sourceVendors: string[];
  confidence: number;
  estimatedCostUsd: number;
  sourceDetails: string;
};

function getConfig() {
  const host = process.env.CLICKHOUSE_VERT_HOST;
  const username = process.env.CLICKHOUSE_USERNAME;
  const password = process.env.CLICKHOUSE_PASSWORD;

  if (!host || !username || !password) {
    throw new Error("CLICKHOUSE_NOT_CONFIGURED");
  }

  const url = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`);
  return { url, username, password };
}

export async function clickHouseRequest(sql: string, timeoutMs = 30_000): Promise<Response> {
  const { url, username, password } = getConfig();
  return fetch(url, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": username,
      "X-ClickHouse-Key": password,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: sql,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function clickHouseJson<T>(
  sql: string,
  params: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<ClickHouseResponse<T>> {
  const { url, username, password } = getConfig();
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(`param_${key}`, value);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": username,
      "X-ClickHouse-Key": password,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: sql,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`CLICKHOUSE_QUERY_FAILED:${response.status}:${await response.text()}`);
  }
  return (await response.json()) as ClickHouseResponse<T>;
}

export async function listExistingProfiles(input: {
  query: string;
  profileType: "musician" | "brand" | "creator" | "actor";
  page: number;
  limit: number;
  tier?: number;
  sortBy: "tier_rank" | "name";
  sortDirection: "asc" | "desc";
}): Promise<{ profiles: ExistingProfile[]; hasMore: boolean }> {
  const offset = (input.page - 1) * input.limit;
  const requestedRows = input.limit + 1;
  const orderBy =
    input.sortBy === "name"
      ? `profile_name ${input.sortDirection.toUpperCase()}, profile_id ASC`
      : `tier_rank ${input.sortDirection.toUpperCase()}, profile_id ASC`;

  const profileSql = `
    SELECT
      p.id AS profile_id,
      any(p.name) AS profile_name,
      any(pt.profile_type) AS profile_types,
      any(pt.tier) AS tier,
      any(pt.tier_rank) AS tier_rank
    FROM new_vertical.profile p
    INNER JOIN new_vertical.l_profile_tier pt
      ON p.id = pt.profile
      AND pt.profile_type = '${input.profileType}'
      AND pt.grain = 'global'
    JOIN new_vertical.l_profile_account lpa ON p.id = lpa.profile_id
    JOIN new_vertical.account a ON lpa.account_id = a.id
    WHERE a.platform = 'instagram'
      AND a.account_url IS NOT NULL
      ${input.tier ? `AND pt.tier = ${input.tier}` : "AND pt.tier BETWEEN 1 AND 5"}
      ${input.query.trim() ? `AND (
        positionCaseInsensitiveUTF8(p.name, {search:String}) > 0
        OR positionCaseInsensitiveUTF8(a.handle, {search:String}) > 0
      )` : ""}
    GROUP BY p.id
    ORDER BY ${orderBy}
    LIMIT ${requestedRows}
    OFFSET ${offset}
    FORMAT JSON
  `;

  const profilePayload = await clickHouseJson<ClickHouseProfileRow>(profileSql, {
    search: input.query.trim(),
  });
  const hasMore = profilePayload.data.length > input.limit;
  const profileRows = profilePayload.data.slice(0, input.limit);
  if (profileRows.length === 0) return { profiles: [], hasMore };

  const profileIds = profileRows.map((row) => row.profile_id).join(",");
  const linkPayload = await clickHouseJson<ProfileAccountLinkRow>(`
    SELECT profile_id, account_id
    FROM new_vertical.l_profile_account
    WHERE profile_id IN (${profileIds})
    FORMAT JSON
  `);
  const accountIds = [...new Set(linkPayload.data.map((row) => row.account_id))];
  const accountPayload = accountIds.length
    ? await clickHouseJson<AccountRow>(`
        SELECT id, platform, handle, ifNull(account_url, '') AS account_url, source
        FROM new_vertical.account
        WHERE id IN (${accountIds.join(",")})
          AND handle != ''
        FORMAT JSON
      `)
    : { data: [] };

  const accountById = new Map(accountPayload.data.map((account) => [account.id, account]));
  const instagramAccountIds = accountPayload.data
    .filter((account) => account.platform.toLowerCase() === "instagram")
    .map((account) => account.id);
  const followerPayload = instagramAccountIds.length
    ? await clickHouseJson<InstagramFollowerRow>(`
        SELECT
          account_id,
          argMax(followers, tuple(snapshot_date, created_at)) AS followers
        FROM new_vertical.instagram_cache
        WHERE account_id IN (${instagramAccountIds.join(",")})
        GROUP BY account_id
        FORMAT JSON
      `)
    : { data: [] };
  const followersByAccount = new Map(
    followerPayload.data.map((row) => [row.account_id, row.followers]),
  );
  const accountsByProfile = new Map<number, ExistingProfileAccount[]>();
  const instagramFollowersByProfile = new Map<number, number>();
  const seen = new Set<string>();
  for (const link of linkPayload.data) {
    const account = accountById.get(link.account_id);
    if (!account) continue;
    const key = `${link.profile_id}:${account.platform}:${account.handle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const accounts = accountsByProfile.get(link.profile_id) ?? [];
    accounts.push({
      platform: account.platform,
      handle: account.handle,
      accountUrl: account.account_url,
      source: account.source,
    });
    accountsByProfile.set(link.profile_id, accounts);
    if (account.platform.toLowerCase() === "instagram") {
      const followers = followersByAccount.get(account.id);
      if (followers !== undefined) {
        instagramFollowersByProfile.set(
          link.profile_id,
          Math.max(instagramFollowersByProfile.get(link.profile_id) ?? 0, followers),
        );
      }
    }
  }

  const profiles = profileRows.map((row) => ({
    profileId: row.profile_id,
    profileName: row.profile_name,
    profileTypes: row.profile_types,
    tier: row.tier,
    tierRank: row.tier_rank,
    instagramFollowers: instagramFollowersByProfile.get(row.profile_id) ?? null,
    accounts: (accountsByProfile.get(row.profile_id) ?? []).sort((a, b) =>
      a.platform.localeCompare(b.platform),
    ),
  }));

  return { profiles, hasMore };
}

export async function approveProfileSuggestions(input: {
  profileId: number;
  profileName: string;
  suggestions: ApprovedSuggestion[];
}): Promise<{ inserted: number; approvedAt: string }> {
  const approvedAt = new Date().toISOString();
  const rows = input.suggestions
    .map((suggestion) =>
      JSON.stringify({
        profile_id: input.profileId,
        profile_name: input.profileName,
        platform: suggestion.platform.toLowerCase(),
        handle: suggestion.handle,
        account_url: suggestion.accountUrl,
        source_vendors: suggestion.sourceVendors,
        confidence: suggestion.confidence,
        estimated_cost_usd: suggestion.estimatedCostUsd,
        source_details: suggestion.sourceDetails,
        approved_at: approvedAt.replace("T", " ").replace("Z", ""),
      }),
    )
    .join("\n");

  const response = await clickHouseRequest(
    `INSERT INTO poc_new_verticals.profile_social_suggestion FORMAT JSONEachRow\n${rows}`,
  );
  if (!response.ok) {
    throw new Error(`CLICKHOUSE_INSERT_FAILED:${response.status}:${await response.text()}`);
  }

  return { inserted: input.suggestions.length, approvedAt };
}