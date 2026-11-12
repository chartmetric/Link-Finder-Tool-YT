import test from "node:test";
import assert from "node:assert/strict";
import { GetArtistResultRowsParams, GetArtistResultRowsResponse } from "@workspace/api-zod";
import { youtubeRow, youtubeResultId, youtubeFieldDefinitions, type CampaignArtist, type ArchivedCandidate } from "../src/lib/youtube-campaign-results-model";
import { paginateResults, resultCsv, type BatchDocument } from "../src/lib/artist-result-model";
import { loadYoutubeArtistRows, optionalYoutubeArchive, youtubeIndexedFilter, youtubeResultsPage, youtubeResultsExport } from "../src/lib/youtube-campaign-results";

const a: CampaignArtist = { profile_id: "101", cm_artist: "201", artist: "Synthetic 日本語 Artist", tier: 2,
  status: "completed", reason: null, result_sha256: "a".repeat(64), candidates: 1, checked: true, likely: true };
const candidate: ArchivedCandidate = {
  url: "https://www.youtube.com/@synthetic", title: "Saved title", snippet: "Not a bio",
  capture: { body: { channelId: "UC1234567890123456789012", description: "Captured bio, not snippet" } },
  decision: { status: "likely_artist_owned", reason: "recorded_model_likely_artist_owned", reviewSuggestion: true, score: 0.71 },
  metadataActuallyUsed: { state: { exact: "untruncated input" } },
  recordedAnswer: { answer: { verdict: "likely" }, resolvedModel: "dated-model", providerReportedUsd: 0.001 },
};
const record = { artist: { profileId: "101", cmArtist: "201", name: a.artist, extra: "catalog context" },
  searchStatus: "candidates_found", candidates: [candidate] };
const observed = "2026-11-11T00:00:00Z";
const field = (row: ReturnType<typeof youtubeRow>, label: string) => row.fields.find(f => f.label === label)!.value;
function document(rows: ReturnType<typeof youtubeRow>[]): BatchDocument {
  return { batch: { id: youtubeResultId, title: "Synthetic", createdAt: observed, status: "running", source: "research",
    artistCount: rows.length, candidateCount: rows.length, rowCount: rows.length, verifiedCount: 0, reviewCount: 0,
    notInspectedCount: 0, metadataFailedCount: 0, noCandidateCount: 0, reservedUsd: 1, reportedUsd: null, explanation: "Synthetic" }, rows };
}
test("likely below .9 is a suggestion, not verification, with all exact archived evidence", () => {
  const row = youtubeRow(a, candidate, 0, [], observed, record);
  assert.equal(row.status, "likely"); assert.equal(row.verifiedUrl, null);
  assert.equal(row.score, .71); assert.equal(field(row, "Likely YouTube suggestion"), candidate.url);
  assert.equal(field(row, "Exact metadata actually prepared for model (JSON)"), JSON.stringify(candidate.metadataActuallyUsed));
  assert.equal(field(row, "Captured channel details (JSON)"), JSON.stringify(candidate.capture));
  assert.equal(field(row, "Full archived candidate (JSON)"), JSON.stringify(candidate));
  assert.equal(field(row, "Chartmetric artist ID"), "201");
  assert.equal(field(row, "Artist name"), a.artist);
  assert.equal(row.fields.length, youtubeFieldDefinitions.length);
});
test("later cross-artist channel reuse overrides historical positives without mutating evidence", () => {
  const before = JSON.stringify(record);
  for (const artist of [a, { ...a, likely: false, reason: "channel_reused_across_catalog_artists" }]) {
    const row = youtubeRow(artist, candidate, 0, ["101", "102"], observed, record);
    assert.equal(row.status, "shared_handle"); assert.equal(row.verdict, "ownership_conflict");
    assert.equal(field(row, "Current likely suggestion"), "false");
    assert.equal(field(row, "Likely YouTube suggestion"), "");
    assert.equal(field(row, "Archived decision (JSON)"), JSON.stringify(candidate.decision));
    const doc = document([row]);
    assert.equal(paginateResults(doc, 0, 25, "", "likely").total, 0);
    assert.equal(paginateResults(doc, 0, 25, "", "checked_not_accepted").total, 0);
    assert.equal(paginateResults(doc, 0, 25, "", "shared_handle").total, 1);
    assert.match(resultCsv(doc), /ownership_conflict/);
    assert.match(resultCsv(doc), /likely_artist_owned/);
  }
  assert.equal(JSON.stringify(record), before);
  assert.equal(youtubeRow({ ...a, reason: "channel_reused_across_catalog_artists", likely: false },
    candidate, 0, [], observed, record).status, "shared_handle");
});
test("Topic rows and CSV are labeled without upgrading historical findings or hiding conflicts", () => {
  const topic = { ...candidate, capture: { ...candidate.capture, body: { channelId: "UC123456", displayName: "日本語 - Topic" } },
    decision: { ...candidate.decision, status: "related_catalog_channel", channelType: "topic", reviewSuggestion: false } };
  const before = JSON.stringify(topic);
  const row = youtubeRow({ ...a, likely: false }, topic, 0, [], observed, record);
  assert.equal(field(row, "Channel type label"), "Topic — auto-generated");
  assert.equal(field(row, "YouTube channel type"), "topic");
  assert.equal(field(row, "Current likely suggestion"), "false");
  assert.match(field(row, "Topic identity status"), /needs review/);
  assert.match(resultCsv(document([row])), /Topic — auto-generated/);
  assert.equal(JSON.stringify(topic), before);
  const supported = { ...topic, decision: { ...topic.decision, status: "supported_topic", reviewSuggestion: true } };
  const accepted = youtubeRow(a, supported, 0, [], observed, record);
  assert.equal(accepted.status, "likely");
  assert.equal(accepted.verifiedUrl, null);
  assert.match(field(accepted, "Topic identity status"), /not artist-owned/);
  assert.equal(youtubeRow(a, supported, 0, ["101", "102"], observed, record).status, "shared_handle");
});
test("checked outcomes, pending metadata, size holds and no-channel searches remain distinct", () => {
  const cases = [
    [{ ...candidate, decision: { ...candidate.decision, status: "related_catalog_channel", reviewSuggestion: false } }, "checked_not_accepted"],
    [{ ...candidate, decision: { ...candidate.decision, status: "needs_identity_check", reason: "recorded_model_uncertain_or_unresolved_channel_type", reviewSuggestion: false } }, "checked_not_accepted"],
    [{ ...candidate, decision: { ...candidate.decision, status: "needs_identity_check", reason: "model_request_exceeds_approved_byte_limit", reviewSuggestion: false } }, "held"],
    [{ ...candidate, decision: { ...candidate.decision, status: "needs_channel_metadata", reviewSuggestion: false } }, "metadata_failed"],
  ] as const;
  for (const [c, status] of cases) assert.equal(youtubeRow(a, c, 0, [], observed, record).status, status);
  assert.equal(youtubeRow({ ...a, candidates: 0 }, null, 0, [], observed, { ...record, searchStatus: "no_match", candidates: [] }).status, "no_channel");
  assert.equal(youtubeRow(a, null, 0, [], observed).status, "unavailable");
  for (const status of ["queued", "deferred", "failed", "in_progress"]) {
    assert.equal(youtubeRow({ ...a, status }, null, 0, [], observed).status, status === "in_progress" ? "pending" : status);
  }
  const held = youtubeRow(a, { ...candidate, recordedAnswer: undefined }, 0, [], observed, record);
  assert.match(field(held, "Model delivery status"), /Prepared input only/);
});
test("candidate pagination, search IDs, API contract and complete CSV retain every candidate field", () => {
  const rows = [youtubeRow(a, candidate, 0, [], observed, record),
    youtubeRow(a, { ...candidate, url: "https://www.youtube.com/@other",
      decision: { ...candidate.decision, reviewSuggestion: false, status: "not_artist_owned" } }, 1, [], observed, record)];
  const doc = document(rows);
  assert.equal(paginateResults(doc, 0, 1, "201", "all").total, 2);
  assert.equal(paginateResults(doc, 0, 1, "UC123456", "all").total, 2);
  assert.equal(paginateResults(doc, 0, 1, "", "all").nextOffset, 1);
  for (const status of ["likely", "checked_not_accepted", "no_channel", "pending", "deferred", "failed", "queued"]) {
    assert.ok(GetArtistResultRowsParams.safeParse({ batchId: youtubeResultId, offset: 0, pageSize: 25, searchTerm: "q:", resultFilter: status }).success);
  }
  assert.equal(GetArtistResultRowsResponse.parse(paginateResults(doc, 0, 25, "", "likely")).rows.length, 1);
  const csv = resultCsv(doc);
  for (const [label] of youtubeFieldDefinitions) assert.ok(csv.includes(label));
  assert.match(csv, /日本語/); assert.match(csv, /untruncated input/); assert.match(csv, /@other/);
  assert.match(csv, /dated-model/); assert.match(csv, /Captured bio, not snippet/);
  assert.equal(csv.split("\r\n").length, 4);
});
test("publication lag retains unavailable rows and missing receipts without inventing outcomes", async () => {
  const missing404 = Object.assign(new Error("not mirrored"), { code: 404 });
  const receipts = [{ profile_id: a.profile_id, operation_key: "search-101", receipt_sha256: "c".repeat(64) }];
  const missing = await loadYoutubeArtistRows(a, receipts, new Map(), observed, async () => { throw missing404; });
  assert.equal(missing.length, 1); assert.equal(missing[0].status, "unavailable");
  assert.equal(field(missing[0], "Current likely suggestion"), "false");
  assert.match(field(missing[0], "Archive availability"), /artists\/101/);
  assert.match(field(missing[0], "Archive availability"), /receipts\//);
  const partial = await loadYoutubeArtistRows(a, receipts, new Map(), observed, async name => {
    if (name.startsWith("artists/")) return record;
    throw missing404;
  });
  assert.equal(partial[0].candidateUrl, candidate.url);
  assert.match(field(partial[0], "Archive availability"), /Missing archived files/);
  assert.equal(field(partial[0], "Full archived candidate (JSON)"), JSON.stringify(candidate));
  assert.ok(resultCsv(document(partial)).includes("Missing archived files"));
  await assert.rejects(optionalYoutubeArchive("artists/101.json", a.result_sha256!, [], async () => {
    throw Error("Archive differs from committed evidence.");
  }), /differs/);
  await assert.rejects(loadYoutubeArtistRows(a, receipts, new Map(), observed, async () => {
    throw Object.assign(Error("access denied"), { code: 403 });
  }), /access denied/);
});
test("artist filters use coordinator summaries and parameterized indexed identity searches", () => {
  const f = youtubeIndexedFilter("A_%!", "likely");
  assert.match(f.sql, /a\.likely/); assert.match(f.sql, /channel_reused_across_catalog_artists/);
  assert.equal(f.term, "%a!_!%!!%");
  assert.match(youtubeIndexedFilter("channel", "shared_handle").sql, /youtube_link_campaign_channels/);
  assert.throws(() => youtubeIndexedFilter("", "unavailable"));
});
test("paging hydrates only the selected artists and reports artist cursors separately from candidate rows", async () => {
  let closed = false;
  const artists = [{ ...a, ordinal: 5 }];
  const doc = document([youtubeRow(a, candidate, 0, [], observed, record), youtubeRow(a, candidate, 1, [], observed, record)]);
  const fake = {
    batch: doc.batch, validate: async () => {},
    selected: async (offset: number, limit: number, search: string, filter: string) => {
      assert.deepEqual([offset, limit, search, filter], [5, 1, "", "likely"]);
      return { total: 78000, artists };
    },
    after: async () => artists,
    rows: async (selected: typeof artists) => { assert.equal(selected, artists); return doc.rows; },
    close: async () => { closed = true; },
  };
  const page = await youtubeResultsPage(5, 1, "", "likely", async () => fake);
  assert.equal(page!.total, 78000); assert.equal(page!.pageArtistCount, 1); assert.equal(page!.rows.length, 2);
  assert.equal(page!.nextOffset, 6); assert.ok(closed);
  assert.equal(GetArtistResultRowsResponse.parse(page).pageArtistCount, 1);
});
test("CSV starts with one bounded chunk, keeps stable headers and closes its snapshot on cancellation", async () => {
  let reads = 0, closed = false;
  const artists = Array.from({ length: 250 }, (_, ordinal) => ({ ...a, ordinal, profile_id: String(ordinal + 1) }));
  const doc = document([youtubeRow(a, candidate, 0, [], observed, record)]);
  const fake = {
    batch: doc.batch, validate: async () => {},
    selected: async () => ({ total: 78000, artists }),
    after: async () => { reads++; return artists; },
    rows: async (selected: typeof artists) => {
      assert.ok(selected.length <= 25);
      return selected.map(x => youtubeRow(x, candidate, 0, [], observed, record));
    },
    close: async () => { closed = true; },
  };
  const chunks = youtubeResultsExport(async () => fake);
  const first = await chunks.next();
  assert.equal(reads, 1); assert.equal(first.value!.rows.length, 25);
  const second = await chunks.next();
  assert.equal(reads, 1);
  assert.equal(resultCsv(first.value!).split("\r\n")[0], resultCsv(second.value!).split("\r\n")[0]);
  await chunks.return(); assert.ok(closed);
});
