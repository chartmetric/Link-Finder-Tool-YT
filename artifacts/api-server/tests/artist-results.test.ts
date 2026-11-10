import { test } from "node:test";
import assert from "node:assert/strict";
import { GetArtistResultRowsParams, GetArtistResultRowsResponse, type BulkBrandRun } from "@workspace/api-zod";
import { csvCell, nativeArtistDocument, paginateResults, resultCsv, summarizeRows, normalizeExportDocument, type BatchDocument } from "../src/lib/artist-result-model";

const run = {
  id: "00000000-0000-4000-8000-000000000001", createdAt: "2026-11-09T10:00:00Z", status: "completed",
  items: [
    { status: "completed", candidate: { profileType: "artist", profileId: 1, profileName: "Artist One", tier: 1 },
      result: { profiles: [{ url: "https://www.instagram.com/one/", title: "One", jevVerification: { verdict: "likely", sameIdentityProbability: 0.6 },
        identityComparison: { candidate: { bio: "Saved bio" } } }] },
      platforms: [{ platform: "Instagram", status: "needs_review", reason: "Not accepted", evidenceUrls: [] }] },
    { status: "completed", candidate: { profileType: "artist", profileId: 2, profileName: "Artist Two" }, result: { profiles: [] },
      platforms: [{ platform: "Instagram", status: "not_found", reason: "Completed search, no candidate", evidenceUrls: [] }] },
    { status: "completed", candidate: { profileType: "brand", profileId: 3, profileName: "Not an artist" }, result: { profiles: [] } },
  ],
} as unknown as BulkBrandRun;

test("native results are artist-only, retain candidates, and never promote likely decisions", () => {
  const doc = nativeArtistDocument(run);
  assert.equal(doc.rows.length, 2);
  assert.equal(doc.rows[0].artistName, "Artist One");
  assert.equal(doc.rows[0].candidateUrl, "https://www.instagram.com/one/");
  assert.equal(doc.rows[0].verifiedUrl, null);
  assert.equal(doc.rows[0].status, "review");
  assert.equal(doc.rows[1].status, "no_candidate");
  assert.match(doc.rows[0].fields.find(f => f.label === "Saved candidate evidence (JSON)")!.value, /Saved bio/);
  assert.match(doc.rows[0].fields.find(f => f.label === "Metadata delivery status")!.value, /not an exact archived checker request/);
  assert.equal(GetArtistResultRowsResponse.parse({ ...doc, total: 2, nextOffset: null }).rows.length, 2);
});
test("full verification needs both archived acceptance and verified identity, not a high search score", () => {
  const variant = structuredClone(run);
  const profile = variant.items[0].result!.profiles[0] as any;
  profile.confidenceScore = 99;
  assert.equal(nativeArtistDocument(variant).rows[0].verifiedUrl, null);
  profile.jevVerification = { verdict: "verified", sameIdentityProbability: 0.95 };
  assert.equal(nativeArtistDocument(variant).rows[0].verifiedUrl, null);
  variant.items[0].platforms![0] = { ...variant.items[0].platforms![0], status: "found", evidenceUrls: [profile.url] };
  assert.equal(nativeArtistDocument(variant).rows[0].verifiedUrl, profile.url);
});
test("missing or failed work is not evidence of a completed no-match", () => {
  const variant = structuredClone(run);
  variant.items[1].status = "failed";
  variant.items[1].error = "Provider unavailable";
  assert.equal(nativeArtistDocument(variant).rows[1].status, "review");
  variant.items[1].status = "queued";
  assert.equal(nativeArtistDocument(variant).rows[1].status, "not_inspected");
});
test("pagination and filters preserve exact rows and handle URL searches", () => {
  const doc = nativeArtistDocument(run);
  assert.equal(paginateResults(doc, 0, 1, "instagram.com/one/", "all").total, 1);
  assert.equal(paginateResults(doc, 0, 1, "", "verified").total, 0);
  assert.equal(paginateResults(doc, 0, 1, "", "all").nextOffset, 1);
  assert.equal(paginateResults(doc, 1, 1, "", "all").nextOffset, null);
  assert.throws(() => paginateResults(doc, 0.5, 25, "", "all"));
  assert.throws(() => paginateResults(doc, 0, 51, "", "all"));
  assert.throws(() => paginateResults(doc, 0, 25, "", "unknown"));
  assert.equal(GetArtistResultRowsParams.safeParse({ batchId: "x", offset: "0", pageSize: "25", searchTerm: "q:", resultFilter: "all" }).success, true);
});
test("every original field, including blank and JSON fields, survives full CSV export", () => {
  const doc = nativeArtistDocument(run);
  doc.rows[0].fields.push({ label: "Quoted metadata", value: '{"bio":"a, b\\n日本語"}', group: "metadata" },
    { label: "Blank original field", value: "", group: "raw" }, { label: "Unsafe formula", value: "=1+2", group: "raw" });
  const csv = resultCsv(doc);
  assert.match(csv, /Blank original field/);
  assert.match(csv, /日本語/);
  assert.match(csv, /'=1\+2/);
  assert.match(csv, /""bio""/);
  assert.equal(csv.split("\r\n").length, 4);
});
test("control comparisons never inflate artist coverage or accepted target counts", () => {
  const doc = nativeArtistDocument(run);
  const control = { ...doc.rows[0], id: "control", comparisonType: "control", status: "control", verifiedUrl: "https://www.instagram.com/control/" };
  const counts = summarizeRows([...doc.rows, control]);
  assert.equal(counts.artistCount, 2);
  assert.equal(counts.rowCount, 3);
  assert.equal(counts.verifiedCount, 0);
});
test("metadata-unavailable filtering preserves the original CSV wording and archived source", () => {
  const doc = nativeArtistDocument(run);
  const field = doc.rows[0].fields.find(f => f.label === "Candidate status")!;
  field.value = "Candidate — metadata unavailable";
  const before = JSON.stringify(doc);
  const normalized = normalizeExportDocument(doc);
  assert.equal(normalized.rows[0].status, "metadata_failed");
  assert.equal(normalized.batch.metadataFailedCount, 1);
  assert.equal(paginateResults(normalized, 0, 25, "", "metadata_failed").total, 1);
  assert.match(resultCsv(normalized), /Candidate — metadata unavailable/);
  assert.equal(JSON.stringify(doc), before);
});
test("saved-alternative inspection states survive storage normalization, filtering and CSV without accepting links", () => {
  const doc = nativeArtistDocument(run);
  const statuses = ["uninspected", "unavailable", "inconclusive", "unsupported", "positive_review_suggestion", "no_saved_candidate"];
  doc.rows = statuses.map((status, i) => ({ ...doc.rows[0], id: `alternative:${i}`, profileId: "1", status,
    candidateUrl: status === "no_saved_candidate" ? null : `https://www.instagram.com/alt_${i}/`,
    verifiedUrl: null, comparisonType: null,
    fields: [{ label: "Candidate inspection status", value: status, group: "decision" as const },
      { label: "Captured candidate metadata receipt (JSON)", value: '{"available":false}', group: "metadata" as const }] }));
  doc.batch.details = [{ label: "Original parent spending checkpoint (JSON)", value: '{"maximumSpendCents":20,"reservedCents":4}', group: "provenance" }];
  doc.batch.metrics = [{ label: "Parent approved ceiling", value: "$0.20" }];
  const normalized = normalizeExportDocument(doc);
  assert.deepEqual(normalized.rows.map(r => r.status), statuses);
  assert.equal(normalized.batch.verifiedCount, 0);
  assert.equal(normalized.batch.reviewCount, 1);
  assert.equal(normalized.batch.notInspectedCount, 1);
  assert.equal(normalized.batch.metadataFailedCount, 0); // unavailable is not silently converted to metadata_failed
  assert.equal(normalized.batch.noCandidateCount, 1);
  for (const status of statuses) {
    assert.equal(GetArtistResultRowsParams.safeParse({ batchId: "x", offset: "0", pageSize: "25", searchTerm: "q:", resultFilter: status }).success, true);
    const page = paginateResults(normalized, 0, 25, "", status);
    assert.equal(page.total, 1);
    assert.equal(GetArtistResultRowsResponse.parse(page).rows[0].status, status);
  }
  assert.equal(paginateResults(normalized, 0, 25, "instagram.com/alt_3/", "unsupported").total, 1);
  const csv = resultCsv(normalized);
  for (const status of statuses) assert.ok(csv.includes(status));
  assert.match(csv, /Parent approved ceiling/);
  assert.match(csv, /maximumSpendCents/);
  assert.deepEqual(normalized.batch.details, doc.batch.details);
});
test("recheck filters, batch provenance and CSV preserve research-only distinctions", () => {
  const doc = nativeArtistDocument(run);
  const statuses = ["research_supported", "held", "skipped", "partial_failure", "shared_handle"];
  doc.rows = statuses.map((status, i) => ({ ...doc.rows[0], id: `fixture:${i}`, profileId: String(i), status,
    verifiedUrl: null, comparisonType: null }));
  doc.batch.details = [{ label: "Approval", value: '{"budget":"separate","limit":20}', group: "provenance" }];
  doc.batch.metrics = [{ label: "Research-supported artists", value: "1" }];
  const normalized = normalizeExportDocument(doc);
  for (const filter of statuses) assert.equal(paginateResults(normalized, 0, 25, "", filter).total, 1);
  assert.equal(normalized.batch.verifiedCount, 0);
  assert.equal(normalized.batch.notInspectedCount, 2);
  assert.match(resultCsv(normalized), /Batch \/ Research-supported artists/);
  assert.match(resultCsv(normalized), /""budget"":""separate""/);
  assert.equal(GetArtistResultRowsResponse.parse({ ...normalized, total: 5, nextOffset: null }).batch.details?.length, 1);
});

for (const batchStatus of ["completed", "interrupted_checkpoint"]) {
  test(`shared-handle ${batchStatus} rows preserve artist-bound evidence through display and export`, () => {
    // Synthetic imported-document contract, not a provider capture or ownership claim.
    const sharedUrl = "https://www.instagram.com/shared_synthetic/";
    const metadata = JSON.stringify({ available: true, candidate: { url: sharedUrl, bio: "Shared synthetic bio" } });
    const base = nativeArtistDocument(run);
    const fields = (pid: string, inspected: boolean): BatchDocument["rows"][number]["fields"] => [
      { label: "Artist name", value: `Artist ${pid}`, group: "identity" },
      { label: "Profile ID", value: pid, group: "identity" },
      { label: "Candidate Instagram link", value: inspected ? sharedUrl : "https://www.instagram.com/uninspected_synthetic/", group: "identity" },
      { label: "Verified Instagram link", value: "", group: "identity" },
      { label: "Candidate inspection status", value: inspected ? "inconclusive" : "uninspected", group: "decision" },
      { label: "Captured candidate metadata receipt (JSON)", value: inspected ? metadata : "", group: "metadata" },
      { label: "Recorded model answer (JSON)", value: inspected ? JSON.stringify({
        verdict: pid === "101" ? "likely" : "mismatch", sameIdentityProbability: pid === "101" ? 0.91 : 0.12,
        reason: `answer-for-${pid}`,
      }) : "", group: "decision" },
      { label: "Review-only suggestion (JSON)", value: inspected ? JSON.stringify({
        url: sharedUrl, status: "unresolved_ownership_conflict", reason: "shared_handle_across_catalog_artists",
        evidence: [`review-for-${pid}`], reviewSuggestion: false, verified: false, liveLinkAccepted: false,
      }) : "", group: "decision" },
      ...(inspected ? [
        { label: "jev exact journaled request (JSON)", value: JSON.stringify({
          state: { savedSearchEvidence: { url: sharedUrl }, catalogArtist: { profile_id: pid, cm_artist: pid },
            syntheticRequest: `request-for-${pid}` },
        }), group: "metadata" as const },
        { label: "jev admission and completion receipt (JSON)", value: JSON.stringify({
          admission: { key: `verify-${pid}`, profileId: pid }, completion: { key: `verify-${pid}`, phase: "returned" },
        }), group: "provenance" as const },
      ] : []),
    ];
    const doc: BatchDocument = {
      batch: { ...base.batch, id: `synthetic-shared-${batchStatus}`, source: "diagnostic", status: batchStatus },
      rows: [
        { ...base.rows[0], id: "shared:101", artistName: "Artist 101", profileId: "101", candidateUrl: sharedUrl,
          verifiedUrl: null, status: "inconclusive", score: 0.91, verdict: "likely", fields: fields("101", true) },
        { ...base.rows[0], id: "shared:202", artistName: "Artist 202", profileId: "202", candidateUrl: sharedUrl,
          verifiedUrl: null, status: "inconclusive", score: 0.12, verdict: "mismatch", fields: fields("202", true) },
        { ...base.rows[0], id: "alternative:101", artistName: "Artist 101", profileId: "101",
          candidateUrl: "https://www.instagram.com/uninspected_synthetic/", verifiedUrl: null, status: "uninspected",
          score: null, verdict: null, fields: fields("101", false) },
      ],
    };
    const before = structuredClone(doc);
    const normalized = normalizeExportDocument(doc);
    assert.equal(normalized.batch.status, batchStatus);
    assert.equal(normalized.batch.artistCount, 2);
    assert.equal(normalized.batch.candidateCount, 3); // Shared URL is two distinct artist/account pairs.
    assert.equal(normalized.batch.rowCount, 3);
    assert.equal(normalized.batch.verifiedCount, 0);
    assert.equal(normalized.batch.reviewCount, 0);
    assert.equal(normalized.batch.notInspectedCount, 1);
    assert.deepEqual(normalized.rows, doc.rows);
    const shared = paginateResults(normalized, 0, 1, sharedUrl, "all");
    assert.equal(shared.total, 2);assert.equal(shared.nextOffset, 1);
    for (const [index, expected] of doc.rows.slice(0, 2).entries()) {
      const page = GetArtistResultRowsResponse.parse(paginateResults(normalized, index, 1, sharedUrl, "all"));
      assert.deepEqual(page.rows, [expected]);
      assert.equal(page.nextOffset, index === 0 ? 1 : null);
      assert.deepEqual(paginateResults(normalized, 0, 25, expected.artistName, "inconclusive").rows, [expected]);
      assert.equal(page.rows[0].fields.find(f => f.label === "Captured candidate metadata receipt (JSON)")!.value, metadata);
      const other = expected.profileId === "101" ? "202" : "101";
      assert.doesNotMatch(JSON.stringify(page.rows[0]), new RegExp(`(?:request|answer|review)-for-${other}`));
    }
    const alternative = GetArtistResultRowsResponse.parse(paginateResults(normalized, 0, 25, "", "uninspected"));
    assert.deepEqual(alternative.rows, [doc.rows[2]]);
    assert.equal(paginateResults(normalized, 0, 25, "", "verified").total, 0);
    const csvLines = resultCsv(normalized).split("\r\n");
    const labels = [...new Set(doc.rows.flatMap(row => row.fields.map(field => field.label)))];
    assert.equal(csvLines.length, 5);
    assert.equal(csvLines[0], labels.map(csvCell).join(","));
    for (const [index, row] of doc.rows.entries()) {
      const values = new Map(row.fields.map(field => [field.label, field.value]));
      assert.equal(csvLines[index + 1], labels.map(label => csvCell(values.get(label))).join(","));
    }
    assert.deepEqual(doc, before);
  });
}
