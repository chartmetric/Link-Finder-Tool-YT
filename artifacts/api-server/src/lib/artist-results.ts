import { clickHouseJson } from "./clickhouse-profiles";
import { readBulkRuns } from "./bulk-run-store";
import { nativeArtistDocument, type BatchDocument } from "./artist-result-model";
import { storedArtistBatches, storedArtistDocument } from "./artist-result-storage";
import { bulkOwnership } from "./bulk-ownership-store";
import type { ArtistResultBatch } from "@workspace/api-zod";

let nativeCache: { at: number; batches: ArtistResultBatch[] } | undefined;
let nativeWarnings: string[] = [];
let nativeInFlight: Promise<ArtistResultBatch[]> | undefined;
function loadNativeBatches() {
  if (nativeCache && Date.now() - nativeCache.at < 30_000) return Promise.resolve(nativeCache.batches);
  nativeInFlight ??= nativeBatches().finally(() => { nativeInFlight = undefined; });
  return nativeInFlight;
}
async function nativeBatches(): Promise<ArtistResultBatch[]> {
  if (nativeCache && Date.now() - nativeCache.at < 30_000) return nativeCache.batches;
  // Return summary fields only, not every raw evidence packet from every run.
  const archiveRead = clickHouseJson<{ id: string; createdAt: string; status: string; batchNumber: number; artistCount: number }>(`
    SELECT toString(run_id) AS id, JSONExtractString(state, 'createdAt') AS createdAt,
      JSONExtractString(state, 'status') AS status, JSONExtractUInt(state, 'batchNumber') AS batchNumber,
      length(arrayFilter(i -> JSONExtractString(i, 'candidate', 'profileType') = 'artist',
        JSONExtractArrayRaw(state, 'items'))) AS artistCount
    FROM (SELECT run_id, argMaxIf(data_json, version, event_type = 'snapshot') AS state, max(version) AS latest
      FROM poc_new_verticals.profile_bulk_events GROUP BY run_id)
    WHERE artistCount > 0 ORDER BY latest DESC LIMIT 1000 FORMAT JSON
  `, {}, 10_000);
  const [archiveResult, managedResult] = await Promise.allSettled([archiveRead, bulkOwnership.read()]);
  if (archiveResult.status === "rejected" && managedResult.status === "rejected") throw Error("Native history sources unavailable.");
  nativeWarnings = [];
  if (archiveResult.status === "rejected") nativeWarnings.push("Older ClickHouse batch summaries are temporarily unavailable. Current saved runs and CSV archives are still shown.");
  if (managedResult.status === "rejected") nativeWarnings.push("Current run coordination is unavailable. Archived batches are still shown.");
  const archived = archiveResult.status === "fulfilled" ? archiveResult.value : { data: [] };
  const recent = (managedResult.status === "fulfilled" ? managedResult.value : []).filter(run => run.items.some(i => i.candidate.profileType === "artist"));
  const recentMap = new Map(recent.map(run => [`live-${run.id}`, nativeArtistDocument(run).batch]));
  const batches = archived.data.map(row => recentMap.get(`live-${row.id}`) ?? ({
    id: `live-${row.id}`, title: `Saved artist batch${row.batchNumber ? ` · chunk ${row.batchNumber}` : ""}`,
    createdAt: row.createdAt, status: row.status, source: "live" as const, artistCount: Number(row.artistCount),
    candidateCount: 0, rowCount: 0, verifiedCount: 0, reviewCount: 0, notInspectedCount: 0,
    metadataFailedCount: 0, noCandidateCount: 0, reservedUsd: null, reportedUsd: null,
    explanation: "Open this saved batch to calculate its candidate and evidence counts. Summary counts are not yet loaded.",
  }));
  for (const [id, batch] of recentMap) if (!batches.some(b => b.id === id)) batches.push(batch);
  nativeCache = { at: Date.now(), batches }; return batches;
}
export async function listArtistResults() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const nativeRead = loadNativeBatches().then(value => ({ status: "fulfilled" as const, value }),
    () => ({ status: "rejected" as const }));
  const [exports, native] = await Promise.all([
    storedArtistBatches().then(value => ({ status: "fulfilled" as const, value }),
      () => ({ status: "rejected" as const })),
    Promise.race([nativeRead, new Promise<{ status: "pending" }>(resolve => {
      timer = setTimeout(() => resolve({ status: "pending" }), 2500);
    })]),
  ]);
  clearTimeout(timer);
  if (exports.status === "rejected" && native.status === "rejected") throw Error("Saved batch sources are unavailable. No discovery was started.");
  const warnings: string[] = [];
  if (exports.status === "rejected") warnings.push("Saved CSV export archives could not be loaded. Refresh to retry; this is not an empty history.");
  if (native.status === "rejected") warnings.push("Live bulk-run history could not be loaded. Saved CSV archives are still available.");
  if (native.status === "pending") warnings.push("Older batch history is still loading. CSV archives are available now; Refresh will include history when it is ready.");
  if (native.status === "fulfilled" && native.value.length >= 1000) warnings.push("Showing the latest 1,000 native batches; older CSV archives remain separate.");
  return { batches: [...(exports.status === "fulfilled" ? exports.value.batches : []),
    ...(native.status === "fulfilled" ? native.value : [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    warnings: [...warnings, ...(native.status === "fulfilled" ? nativeWarnings : []),
      ...(exports.status === "fulfilled" ? exports.value.warnings : [])] };
}
export async function artistResultDocument(id: string): Promise<BatchDocument | undefined> {
  if (!id.startsWith("live-")) return storedArtistDocument(id);
  const uuid = id.slice(5);
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid)) return undefined;
  const run = (await readBulkRuns(uuid)).find(r => r.id === uuid);
  if (!run || !run.items.some(i => i.candidate.profileType === "artist")) return undefined;
  return nativeArtistDocument(run);
}
