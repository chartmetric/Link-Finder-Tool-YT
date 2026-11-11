import test from "node:test";
import assert from "node:assert/strict";
import {buildYoutubeArtistProgress, validateYoutubeArtistProgress, youtubeDigest, YOUTUBE_RUN_ID}
  from "../src/lib/youtube-artist-progress-model";
import {createYoutubeProgressStore} from "../src/lib/youtube-artist-progress";

function fixture() {
  const scope = Array.from({length: 5}, (_, i) => ({profile_id: String(i + 1), cm_artist: String(i + 101), tier: i + 1}));
  const approval = {id: YOUTUBE_RUN_ID, scope, scopeSha256: youtubeDigest(scope), artists: 5, capCents: 200};
  const budget = {id: YOUTUBE_RUN_ID, scope_sha256: approval.scopeSha256, cap_cents: 200, reserved_cents: 128, status: "completed"};
  const decision = (status: string, reason: string, score: number | null = null) => ({
    status, reason, score, reviewSuggestion: status === "likely_artist_owned", inputSha256: "a".repeat(64),
  });
  const row = (i: number, decisions: ReturnType<typeof decision>[], searchStatus = "candidates_found") => ({
    artist: {profileId: scope[i].profile_id, cmArtist: scope[i].cm_artist}, searchStatus,
    candidates: decisions.map(d => ({decision: d})), outcome: searchStatus === "no_match" ? "completed_no_channel_result" : "needs_review",
  });
  const rows = [
    row(0, [decision("likely_artist_owned", "positive", 0.64), decision("likely_artist_owned", "positive", 0.67)]),
    row(1, [decision("needs_identity_check", "recorded_model_uncertain_or_unresolved_channel_type", 0.3)]),
    row(2, [decision("needs_identity_check", "model_request_exceeds_approved_byte_limit")]),
    row(3, [], "no_match"),
    row(4, [], "failed"),
  ];
  const build = () => buildYoutubeArtistProgress(approval, rows, budget, "completed",
    "2026-11-11T01:00:00Z", "2026-11-11T02:00:00Z");
  return {approval, budget, rows, build};
}
test("artist-level progress separates completed search, ownership checks, held evidence and no-result searches", () => {
  const p = fixture().build();
  assert.equal(p.totalArtists, 5);
  assert.equal(p.searchedArtists, 4); // failed is not no-match or completed search
  assert.equal(p.processedPercent, 80);
  assert.equal(p.checkedArtists, 2);
  assert.equal(p.likelyMatches, 1); // two matching channels still one artist
  assert.equal(p.notAcceptedArtists, 1);
  assert.equal(p.uncheckedArtists, 1); // held candidate not a rejection
  assert.equal(p.noChannelFound, 1);
  assert.equal(p.heldCandidates, 1);
  assert.equal(p.pendingCandidates, 2);
  assert.equal(p.successRate, 50); // artists with an actual ownership assessment
  assert.equal(p.reservedUsd, 1.28);
  assert.equal(p.maximumSpendUsd, 2);
});
test("no completed checks yields an unknown rate, not zero success", () => {
  const f = fixture();
  f.rows.splice(0, f.rows.length, f.rows[2]);
  const p = f.build();
  assert.equal(p.checkedArtists, 0);
  assert.equal(p.successRate, null);
  assert.equal(p.notAcceptedArtists, 0);
});
test("duplicate artists, mismatched catalog identities, changed approval and false suggestions fail closed", () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => f.rows.push(f.rows[0]),
    (f: ReturnType<typeof fixture>) => { f.rows[0].artist.cmArtist = "other"; },
    (f: ReturnType<typeof fixture>) => { f.approval.scopeSha256 = "changed"; },
    (f: ReturnType<typeof fixture>) => { f.rows[2].candidates[0].decision.reviewSuggestion = true; },
    (f: ReturnType<typeof fixture>) => { f.rows[3].candidates.push(f.rows[0].candidates[0]); },
  ];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(f.build); }
});
test("snapshot validates ratios, caps and timestamps and strips non-counter data", () => {
  const p = fixture().build();
  assert.equal("bio" in validateYoutubeArtistProgress({...p, bio: "not for publication"}), false);
  for (const changes of [{successRate: 100}, {processedPercent: 0}, {likelyMatches: 10},
    {reservedUsd: 3}, {maximumSpendUsd: 100}, {capturedAt: "bad"}, {runId: "instagram"}])
    assert.throws(() => validateYoutubeArtistProgress({...p, ...changes}));
});
function storageMock(initial?: unknown, failure?: object) {
  let saved = initial, generation = 1;
  const writes: any[] = [];
  const file: any = {
    name: "counter.json",
    getMetadata: async () => {
      if (failure) throw failure;
      if (!saved) throw {code: 404};
      return [{size: JSON.stringify(saved).length, generation: String(generation)}];
    },
    download: async () => [Buffer.from(JSON.stringify(saved))],
    save: async (text: string, options: any) => { writes.push(options); saved = JSON.parse(text); generation++; },
  };
  file.bucket = {file: (_name: string, options: any) => {
    assert.equal(options.generation, String(generation)); return file;
  }};
  return {store: createYoutubeProgressStore(() => file), writes};
}
test("shared progress survives separate reads, uses a generation fence and does not publish evidence", async () => {
  const p = fixture().build(), mock = storageMock();
  assert.equal(await mock.store.load(), null);
  await mock.store.publish(p);
  assert.deepEqual(await mock.store.load(), p);
  assert.equal(mock.writes[0].preconditionOpts.ifGenerationMatch, 0);
  await mock.store.publish({...p, capturedAt: "2026-11-11T03:00:00Z"});
  assert.equal(mock.writes[1].preconditionOpts.ifGenerationMatch, "2");
});
test("corrupt snapshots and storage errors are unavailable, never invented zeroes", async () => {
  await assert.rejects(storageMock({runId: "bad"}).store.load());
  await assert.rejects(storageMock(undefined, {code: 503}).store.load());
  const p = fixture().build(), mock = storageMock(p);
  await assert.rejects(mock.store.publish({...p, reservedUsd: 1}), /older or different/);
  assert.equal(mock.writes.length, 0);
});
