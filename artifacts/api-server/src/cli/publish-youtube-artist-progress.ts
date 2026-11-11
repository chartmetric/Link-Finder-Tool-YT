// Counter-only publication. No provider/worker imports, claims, retries or DDL.
import assert from "node:assert/strict";
import {readFile, stat} from "node:fs/promises";
import path from "node:path";
import {workspaceRoot} from "../lib/artist-campaign-progress";
import {buildYoutubeArtistProgress, YOUTUBE_RUN_ID} from "../lib/youtube-artist-progress-model";
import {publishYoutubeProgress} from "../lib/youtube-artist-progress";
import {logger} from "../lib/logger";

async function main() {
  assert.deepEqual(process.argv.slice(2), ["--publish", `--run-id=${YOUTUBE_RUN_ID}`]);
  const root = path.join(await workspaceRoot(), "generated-artifacts", YOUTUBE_RUN_ID);
  const read = async (name: string) => JSON.parse(await readFile(path.join(root, name), "utf8"));
  const approval = await read("approval.json");
  const outcomes = await read("ownership-check-execution/artist-outcomes.json");
  const summary = await read("ownership-check-execution/summary.json");
  const {pool} = await import("@workspace/db");
  const client = await pool.connect();
  let progress;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='15s'");
    const parent = (await client.query(`SELECT id,scope_sha256,cap_cents,reserved_cents,status
      FROM youtube_discovery_test_runs WHERE id=$1`, [YOUTUBE_RUN_ID])).rows[0];
    const phases = (await client.query(`SELECT id,status,reserved_cents,prior_reserved_cents
      FROM youtube_ownership_checks WHERE parent_id=$1`, [YOUTUBE_RUN_ID])).rows;
    assert.equal(phases.length, 1);
    const phase = phases[0];
    const counts = (await client.query(`SELECT count(*)::int admitted,
      count(*) FILTER(WHERE status='returned')::int returned,
      count(*) FILTER(WHERE kind='model')::int models,
      count(*) FILTER(WHERE kind='metadata')::int metadata,
      coalesce(sum(reserved_cents),0)::int reserved
      FROM youtube_ownership_admissions WHERE check_id=$1`, [phase.id])).rows[0];
    assert.equal(counts.admitted, counts.returned, "Uncertain ownership request; no publication.");
    assert.equal(counts.models, summary.modelCalls);
    assert.equal(counts.metadata, summary.metadataCalls);
    assert.equal(phase.status, summary.status);
    assert.equal(parent.reserved_cents, phase.prior_reserved_cents + phase.reserved_cents);
    assert.equal(counts.reserved, phase.reserved_cents);
    assert.equal(parent.reserved_cents, summary.budget.combined_reserved_cents);
    assert.equal(outcomes.length, approval.artists);
    const info = await stat(path.join(root, "ownership-check-execution/summary.json"));
    progress = buildYoutubeArtistProgress(approval, outcomes, parent, phase.status,
      info.mtime.toISOString(), new Date().toISOString());
    assert.equal(progress.likelyMatches, summary.artistsWithLikelyChannels);
    assert.equal(progress.noChannelFound, summary.completedNoChannelResult);
    assert.equal(progress.heldCandidates, summary.heldOversized);
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
  finally { client.release(); await pool.end(); }
  await publishYoutubeProgress(progress);
  logger.info({runId: progress.runId, searched: progress.searchedArtists,
    checked: progress.checkedArtists, likely: progress.likelyMatches},
    "Saved YouTube counters published; no paid work performed");
}
main().catch(error => {
  logger.error({err: error}, "YouTube counter publication stopped; existing counters were preserved");
  process.exitCode = 1;
});
