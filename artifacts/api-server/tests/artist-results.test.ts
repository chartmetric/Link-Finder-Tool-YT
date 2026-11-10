import { test } from "node:test";
import assert from "node:assert/strict";
import { GetArtistResultRowsParams, GetArtistResultRowsResponse, type BulkBrandRun } from "@workspace/api-zod";
import { nativeArtistDocument, paginateResults, resultCsv, summarizeRows, normalizeExportDocument, type BatchDocument } from "../src/lib/artist-result-model";

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
