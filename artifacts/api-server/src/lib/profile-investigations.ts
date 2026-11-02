import { randomUUID } from "node:crypto";
import { SearchProfilesResponse, type ProfileSearchResponse } from "@workspace/api-zod";
import { clickHouseJson, clickHouseRequest } from "./clickhouse-profiles";
import { invalidateBulkCoverage } from "./bulk-coverage";

const table = "poc_new_verticals.profile_search_history";
let initialization: Promise<void> | undefined;

async function ensureHistoryTable() {
  if (!initialization) {
    initialization = (async () => {
      const response = await clickHouseRequest(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id UUID,
          known_profile_url String,
          subject String,
          searched_at DateTime64(3, 'UTC'),
          result_json String
        ) ENGINE = MergeTree
        ORDER BY (searched_at, id)
      `, 2_000);
      if (!response.ok) throw new Error(`HISTORY_SETUP_FAILED:${response.status}:${await response.text()}`);
    })().catch((error) => {
      initialization = undefined;
      throw error;
    });
  }
  await initialization;
}

export async function saveProfileInvestigation(knownProfileUrl: string, result: ProfileSearchResponse) {
  await ensureHistoryTable();
  const id = randomUUID();
  const row = JSON.stringify({
    id,
    known_profile_url: knownProfileUrl,
    subject: result.subject,
    searched_at: result.searchedAt.toISOString().replace("T", " ").replace("Z", ""),
    result_json: JSON.stringify({ ...result, historyId: id }),
  });
  const response = await clickHouseRequest(`INSERT INTO ${table} FORMAT JSONEachRow\n${row}`, 3_000);
  if (!response.ok) throw new Error(`HISTORY_SAVE_FAILED:${response.status}:${await response.text()}`);
  invalidateBulkCoverage();
  return id;
}

export async function listProfileInvestigations(page: number, limit: number) {
  await ensureHistoryTable();
  const result = await clickHouseJson<{
    id: string;
    known_profile_url: string;
    result_json: string;
  }>(`
    SELECT id, known_profile_url, result_json
    FROM ${table}
    ORDER BY searched_at DESC, id DESC
    LIMIT ${limit + 1} OFFSET ${(page - 1) * limit}
    FORMAT JSON
  `, {}, 5_000);
  return {
    investigations: result.data.slice(0, limit).map((row) => ({
      id: row.id,
      knownProfileUrl: row.known_profile_url,
      result: SearchProfilesResponse.parse(JSON.parse(row.result_json)),
    })),
    page,
    limit,
    hasMore: result.data.length > limit,
  };
}