import type { BulkBrandRun, ArtistResultBatch, ArtistResultRow } from "@workspace/api-zod";

export type BatchDocument = { batch: ArtistResultBatch; rows: ArtistResultRow[] };
export const artistResultFilters = ["all", "verified", "review", "not_inspected", "metadata_failed", "no_candidate", "controls",
  "research_supported", "held", "skipped", "partial_failure", "shared_handle",
  "uninspected", "unavailable", "inconclusive", "unsupported", "positive_review_suggestion", "no_saved_candidate"] as const;
export function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function resultCsv(doc: BatchDocument) {
  const batchFields = [
    ...(doc.batch.metrics ?? []).map(f => ({ label: `Batch / ${f.label}`, value: f.value })),
    ...(doc.batch.details ?? []).map(f => ({ label: `Batch / ${f.label}`, value: f.value })),
  ];
  const labels = [...new Set([...doc.rows.flatMap(r => r.fields.map(f => f.label)), ...batchFields.map(f => f.label)])];
  return [labels.map(csvCell).join(","), ...doc.rows.map(row => {
    const values = new Map([...row.fields, ...batchFields].map(f => [f.label, f.value]));
    return labels.map(label => csvCell(values.get(label))).join(",");
  })].join("\r\n") + "\r\n";
}
export function paginateResults(doc: BatchDocument, offset: number, limit: number, search: string, filter: string) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
    || search.length > 120 || !(artistResultFilters as readonly string[]).includes(filter)) throw Error("Invalid result filters.");
  const term = search.trim().toLocaleLowerCase();
  const matches = doc.rows.filter(row => (filter === "all"
    || (filter === "controls" ? row.comparisonType === "control" : row.status === filter))
    && (!term || `${row.artistName} ${row.profileId} ${row.candidateUrl ?? ""} ${row.verifiedUrl ?? ""}`.toLocaleLowerCase().includes(term)));
  return { batch: doc.batch, rows: matches.slice(offset, offset + limit), total: matches.length,
    nextOffset: offset + limit < matches.length ? offset + limit : null };
}
export function summarizeRows(rows: ArtistResultRow[]) {
  const targets = rows.filter(r => r.comparisonType !== "control");
  return { artistCount: new Set(targets.map(r => r.profileId)).size,
    candidateCount: new Set(targets.filter(r => r.candidateUrl).map(r => `${r.profileId}:${r.candidateUrl}`)).size,
    rowCount: rows.length, verifiedCount: targets.filter(r => r.verifiedUrl).length,
    reviewCount: targets.filter(r => ["review", "positive_review_suggestion"].includes(r.status)).length,
    notInspectedCount: targets.filter(r => ["not_inspected", "held", "skipped", "uninspected"].includes(r.status)).length,
    metadataFailedCount: targets.filter(r => r.status === "metadata_failed").length,
    noCandidateCount: targets.filter(r => ["no_candidate", "no_saved_candidate"].includes(r.status)).length };
}
export function normalizeExportDocument(doc: BatchDocument): BatchDocument {
  const rows = doc.rows.map(row => row.fields.some(f => f.label === "Candidate status"
    && /metadata.*unavailable/i.test(f.value)) ? { ...row, status: "metadata_failed" } : row);
  return { batch: { ...doc.batch, ...summarizeRows(rows) }, rows };
}
function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function instagramUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port
      && ["instagram.com", "www.instagram.com"].includes(u.hostname) ? value : null;
  } catch { return null; }
}
export function nativeArtistDocument(run: BulkBrandRun): BatchDocument {
  const rows: ArtistResultRow[] = [];
  for (const item of run.items.filter(i => i.candidate.profileType === "artist")) {
    const saved = record(item.result);
    const profiles = (Array.isArray(saved.profiles) ? saved.profiles : []).filter((p: any) => instagramUrl(p.url));
    const candidates: any[] = profiles.length ? profiles : [null];
    for (const [index, profile] of candidates.entries()) {
      const p = record(profile), comparison = record(p.identityComparison), decision = record(p.jevVerification);
      const url = instagramUrl(p.url);
      const score = typeof decision.sameIdentityProbability === "number" ? decision.sameIdentityProbability : null;
      const verdict = typeof decision.verdict === "string" ? decision.verdict : null;
      const outcome = item.platforms?.find(o => o.platform === "Instagram");
      const supported = url !== null && outcome?.status === "found" && outcome.evidenceUrls.includes(url)
        && verdict === "verified" && score !== null && score >= 0.9 && score <= 1;
      const status = supported ? "verified" : p.metadataError ? "metadata_failed" : item.status === "failed" ? "review"
        : !url ? (item.status === "completed" && outcome?.status === "not_found" ? "no_candidate" : "not_inspected")
        : !Object.keys(comparison).length ? "not_inspected" : "review";
      const fields: ArtistResultRow["fields"] = [
        { label: "Artist name", value: item.candidate.profileName, group: "identity" },
        { label: "Profile ID", value: String(item.candidate.profileId), group: "identity" },
        { label: "Tier", value: String(item.candidate.tier ?? ""), group: "identity" },
        { label: "Verified Instagram link", value: supported ? url! : "", group: "identity" },
        { label: "Candidate Instagram link", value: url ?? "", group: "identity" },
        { label: "Candidate status", value: status, group: "decision" },
        { label: "Identity score", value: score === null ? "" : String(score), group: "decision" },
        { label: "Verdict", value: verdict ?? "", group: "decision" },
        { label: "Artist run status", value: item.status, group: "decision" },
        { label: "Outcome or error", value: item.error ?? outcome?.reason ?? "", group: "decision" },
        { label: "Saved artist and catalog accounts (JSON)", value: JSON.stringify(item.candidate), group: "metadata" },
        { label: "Saved candidate evidence (JSON)", value: JSON.stringify(profile), group: "metadata" },
        { label: "Saved platform outcomes (JSON)", value: JSON.stringify(item.platforms ?? []), group: "metadata" },
        { label: "Metadata delivery status", value: "This run retains source evidence, not an exact archived checker request. Do not infer that every saved field was sent.", group: "provenance" },
        { label: "Source run", value: run.id, group: "provenance" },
        { label: "Batch number", value: String(run.batchNumber ?? ""), group: "provenance" },
        { label: "Checked at", value: item.completedAt ?? item.startedAt ?? "", group: "provenance" },
        { label: "Full saved research result (JSON)", value: JSON.stringify(item.result ?? null), group: "raw" },
      ];
      rows.push({ id: `${run.id}:${item.candidate.profileId}:${index}`, artistName: item.candidate.profileName,
        profileId: String(item.candidate.profileId), candidateUrl: url, verifiedUrl: supported ? url : null,
        status, score, verdict, comparisonType: null, fields });
    }
  }
  return { batch: { id: `live-${run.id}`, title: `${run.archiveOf ? "Archived chunk" : "Artist batch"}${run.batchNumber ? ` ${run.batchNumber}` : ""}`,
    createdAt: run.createdAt, status: run.status, source: "live", ...summarizeRows(rows),
    reservedUsd: null, reportedUsd: null,
    explanation: "Saved bulk-run evidence. Suggestions only; no catalog approvals. An absent supported link does not prove that an account does not exist. Estimated provider cost is not a reservation or invoice." }, rows };
}
