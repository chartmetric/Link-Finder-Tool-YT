type ClickHouseProfileRow = {
  account_url: string;
  profile_id: number;
  profile_name: string;
  profile_types: string;
};

type ClickHouseResponse = {
  data: ClickHouseProfileRow[];
};

export type ExistingProfile = {
  profileId: number;
  profileName: string;
  profileTypes: string;
  accountUrl: string;
  handle: string;
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

function extractInstagramHandle(accountUrl: string): string {
  try {
    const pathname = new URL(accountUrl).pathname;
    return pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    return accountUrl.replace(/^@/, "");
  }
}

export async function listExistingProfiles(input: {
  query: string;
  page: number;
  limit: number;
}): Promise<{ profiles: ExistingProfile[]; hasMore: boolean }> {
  const { url, username, password } = getConfig();
  const offset = (input.page - 1) * input.limit;
  const requestedRows = input.limit + 1;
  const filter = input.query.trim()
    ? `AND (
        positionCaseInsensitiveUTF8(p.name, {search:String}) > 0
        OR positionCaseInsensitiveUTF8(a.account_url, {search:String}) > 0
      )`
    : "";

  const sql = `
    SELECT
      a.account_url,
      MIN(p.id) AS profile_id,
      MIN(p.name) AS profile_name,
      arrayStringConcat(groupUniqArray(p.profile_type), ', ') AS profile_types
    FROM new_vertical.profile p
    JOIN new_vertical.l_profile_account lpa ON p.id = lpa.profile_id
    JOIN new_vertical.account a ON lpa.account_id = a.id
    WHERE a.account_url IS NOT NULL
      AND a.platform = 'instagram'
      ${filter}
    GROUP BY a.account_url
    ORDER BY profile_name ASC, profile_id ASC
    LIMIT ${requestedRows}
    OFFSET ${offset}
    FORMAT JSON
  `;

  url.searchParams.set("param_search", input.query.trim());
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": username,
      "X-ClickHouse-Key": password,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: sql,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`CLICKHOUSE_QUERY_FAILED:${response.status}`);
  }

  const payload = (await response.json()) as ClickHouseResponse;
  const hasMore = payload.data.length > input.limit;
  const profiles = payload.data.slice(0, input.limit).map((row) => ({
    profileId: row.profile_id,
    profileName: row.profile_name,
    profileTypes: row.profile_types,
    accountUrl: row.account_url,
    handle: extractInstagramHandle(row.account_url),
  }));

  return { profiles, hasMore };
}