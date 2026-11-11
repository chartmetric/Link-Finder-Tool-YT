import { access, readFile, open, stat } from "node:fs/promises";
import path from "node:path";

type Counts = { processed: number; checked: number; likely: number; reserved: number };
const zero = (): Counts => ({ processed: 0, checked: 0, likely: 0, reserved: 0 });
const count = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw Error("Invalid campaign count.");
  return Number(value);
};
export function checkpointCounts(artist: any): Counts {
  const candidate = artist.candidates?.[0];
  const checked = Boolean(candidate?.recordedAnswer);
  const processed = checked || ["unavailable", "unsupported"].includes(candidate?.status)
    || candidate?.reason === "interrupted_or_uncertain_no_retry";
  return { processed: Number(processed), checked: Number(checked),
    likely: Number(checked && candidate?.review?.reviewSuggestion === true), reserved: 0 };
}
export function progressTotals(total: number, totals: Counts, status: string, updatedAt: string, now = Date.now()) {
  count(total); Object.values(totals).forEach(count);
  if (totals.likely > totals.checked || totals.checked > totals.processed || totals.processed > total)
    throw Error("Campaign totals do not agree.");
  return {
    status, totalArtists: total, processedArtists: totals.processed, checkedArtists: totals.checked,
    likelyMatches: totals.likely, notAcceptedArtists: totals.checked - totals.likely,
    incompleteArtists: totals.processed - totals.checked,
    processedPercent: total ? totals.processed / total * 100 : 0,
    successRate: totals.checked ? totals.likely / totals.checked * 100 : null,
    reservedUsd: totals.reserved / 100, maximumSpendUsd: 100, updatedAt,
    stale: status === "running" && now - Date.parse(updatedAt) > 120_000,
  };
}
async function workspaceRoot() {
  let dir = process.cwd();
  while (true) {
    try { await access(path.join(dir, "pnpm-workspace.yaml")); return dir; }
    catch { const parent = path.dirname(dir); if (parent === dir) throw Error("Workspace unavailable."); dir = parent; }
  }
}
async function json(file: string, optional = false): Promise<any> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (e: any) { if (optional && e.code === "ENOENT") return undefined; throw e; }
}
// Incremental, read-only tail. A partial final line is read again next time.
// Keep counts only; do not retain account bios or other evidence in this cache.
let tail: { file: string; inode: number; offset: number; counts: Map<string, Counts>; reserved: number } | undefined;
async function checkpoint(file: string) {
  const info = await stat(file);
  if (!tail || tail.file !== file || tail.inode !== info.ino || info.size < tail.offset)
    tail = { file, inode: info.ino, offset: 0, counts: new Map(), reserved: 0 };
  const handle = await open(file, "r");
  try {
    while (tail.offset < info.size) {
      const buffer = Buffer.alloc(Math.min(info.size - tail.offset, 16 * 1024 * 1024));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, tail.offset);
      const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (lastNewline < 0) {
        if (buffer.length === 16 * 1024 * 1024) throw Error("Checkpoint record exceeds read limit.");
        break;
      }
      for (const line of buffer.subarray(0, lastNewline).toString("utf8").split("\n").filter(Boolean)) {
        const packet = JSON.parse(line);
        for (const artist of packet.changes ?? []) tail.counts.set(String(artist.profileId), checkpointCounts(artist));
        tail.reserved = count(packet.budget?.reservedCents);
      }
      tail.offset += lastNewline + 1;
    }
  } finally { await handle.close(); }
  const totals = [...tail.counts.values()].reduce((a, b) => ({
    processed: a.processed + b.processed, checked: a.checked + b.checked,
    likely: a.likely + b.likely, reserved: 0,
  }), zero());
  return { ...totals, reserved: tail.reserved, updatedAt: info.mtime.toISOString() };
}
export async function readArtistCampaignFiles(root: string, workspace: string) {
  const approval = await json(path.join(root, "approval.json"), true);
  if (!approval) return { progress: null };
  const progress = await json(path.join(root, "progress.json"));
  const chunks = await json(path.join(root, "chunks.json"), true) ?? [];
  let updatedAt = (await stat(path.join(root, "progress.json"))).mtime.toISOString();
  const totals = zero();
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (!/^generated-artifacts\/next-saved-full-tiers-1-5-usd100-chunk-\d{3}$/.test(chunk.dir))
      throw Error("Unbound campaign chunk.");
    if (seen.has(chunk.dir)) throw Error("Duplicate campaign chunk.");
    seen.add(chunk.dir);
    if (chunk.summary.status === "completed") {
      totals.processed += count(chunk.summary.artistRecords);
      totals.checked += count(chunk.summary.evaluatedArtists);
      totals.likely += count(chunk.summary.likelyReviewArtists);
      totals.reserved += count(chunk.summary.conservativeReservedCents);
    } else {
      // A stopped scope can contain hundreds of untouched artists. Count only
      // terminal checkpoints, never the number of rows allocated to that scope.
      const stopped = await checkpoint(path.join(workspace, chunk.dir, "execution/artist-checkpoints.jsonl"));
      totals.processed += stopped.processed; totals.checked += stopped.checked;
      totals.likely += stopped.likely; totals.reserved += stopped.reserved;
    }
  }
  if (progress.activeChunk && !seen.has(progress.activeChunk)) {
    if (!/^generated-artifacts\/next-saved-full-tiers-1-5-usd100-chunk-\d{3}$/.test(progress.activeChunk))
      throw Error("Unbound campaign checkpoint.");
    const active = await checkpoint(path.join(workspace, progress.activeChunk, "execution/artist-checkpoints.jsonl"));
    totals.processed += active.processed; totals.checked += active.checked;
    totals.likely += active.likely; totals.reserved += active.reserved;
    if (active.updatedAt > updatedAt) updatedAt = active.updatedAt;
  }
  if (totals.reserved > 10000) throw Error("Campaign reservations exceed the approved cap.");
  return { progress: progressTotals(count(approval.eligibleArtists), totals, String(progress.status), updatedAt) };
}

let cached: { at: number; value: Awaited<ReturnType<typeof readArtistCampaignFiles>> } | undefined;
let pending: Promise<Awaited<ReturnType<typeof readArtistCampaignFiles>>> | undefined;
export async function readArtistCampaignProgress() {
  if (cached && Date.now() - cached.at < 4000) return cached.value;
  // Serialize tail offsets across tabs and clients. A failed read must not
  // replace known evidence with an empty or zero snapshot.
  pending ??= (async () => {
    const workspace = await workspaceRoot();
    const value = await readArtistCampaignFiles(
      path.join(workspace, "generated-artifacts/next-saved-full-tiers-1-5-usd100"), workspace);
    cached = { at: Date.now(), value };
    return value;
  })().finally(() => { pending = undefined; });
  return pending;
}
