import { access, readFile, open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ArtistCampaignTierProgress } from "@workspace/api-zod";

type Counts = { processed: number; checked: number; likely: number; reserved: number };
type ArtistCounts = { cmArtist: string; counts: Counts };
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
function artistTotals(total: number, totals: Counts) {
  count(total); Object.values(totals).forEach(count);
  if (totals.likely > totals.checked || totals.checked > totals.processed || totals.processed > total)
    throw Error("Campaign totals do not agree.");
  return {
    totalArtists: total, processedArtists: totals.processed, checkedArtists: totals.checked,
    likelyMatches: totals.likely, notAcceptedArtists: totals.checked - totals.likely,
    incompleteArtists: totals.processed - totals.checked,
    processedPercent: total ? totals.processed / total * 100 : 0,
    successRate: totals.checked ? totals.likely / totals.checked * 100 : null,
  };
}
export function progressTotals(total: number, totals: Counts, status: string, updatedAt: string, now = Date.now()) {
  return {
    ...artistTotals(total, totals), status,
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
type Tail = { inode: number; offset: number; counts: Map<string, ArtistCounts>; reserved: number };
// Each chunk has its own cursor so polling does not reread completed evidence.
const tails = new Map<string, Tail>();
async function checkpoint(file: string) {
  const info = await stat(file);
  let tail = tails.get(file);
  if (!tail || tail.inode !== info.ino || info.size < tail.offset) {
    tail = { inode: info.ino, offset: 0, counts: new Map(), reserved: 0 };
    tails.set(file, tail);
    // Bound cached file handles' metadata even if campaign directories change.
    if (tails.size > 256) tails.delete(tails.keys().next().value!);
  }
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
        for (const artist of packet.changes ?? []) {
          const id = identity(artist.profileId);
          const cmArtist = identity(artist.cmArtist);
          if (tail.counts.has(id) && tail.counts.get(id)!.cmArtist !== cmArtist)
            throw Error("Campaign artist identity changed.");
          tail.counts.set(id, { cmArtist, counts: checkpointCounts(artist) });
        }
        tail.reserved = count(packet.budget?.reservedCents);
      }
      tail.offset += lastNewline + 1;
    }
  } finally { await handle.close(); }
  return { artists: tail.counts, reserved: tail.reserved, updatedAt: info.mtime.toISOString() };
}
function identity(value: unknown): string {
  if ((typeof value !== "string" && typeof value !== "number") || !/^[1-9]\d*$/.test(String(value)))
    throw Error("Invalid campaign artist identity.");
  return String(value);
}
function add(a: Counts, b: Counts) {
  a.processed += b.processed; a.checked += b.checked; a.likely += b.likely;
}
async function tierProgress(root: string, approval: any, artists: Map<string, ArtistCounts>): Promise<ArtistCampaignTierProgress[]> {
  const queue = await json(path.join(root, "queue.json"));
  if (!Array.isArray(queue) || queue.length !== count(approval.eligibleArtists)
    || createHash("sha256").update(JSON.stringify(queue)).digest("hex") !== approval.queueSha256)
    throw Error("Frozen queue does not match approval.");
  const bindings = new Map<string, { cmArtist: string; tier: 1 | 2 | 3 | 4 | 5 }>();
  const cmArtists = new Set<string>();
  const tiers = ([1, 2, 3, 4, 5] as const).map(tier => ({ tier, total: 0, counts: zero() }));
  for (const row of queue) {
    const id = identity(row.profile_id), cmArtist = identity(row.cm_artist), tier = Number(row.tier);
    if (!Number.isInteger(tier) || tier < 1 || tier > 5 || bindings.has(id) || cmArtists.has(cmArtist))
      throw Error("Frozen queue has invalid or duplicate assignments.");
    bindings.set(id, { cmArtist, tier: tier as 1 | 2 | 3 | 4 | 5 });
    cmArtists.add(cmArtist);
    tiers[tier - 1].total++;
  }
  for (const [id, artist] of artists) {
    const binding = bindings.get(id);
    if (!binding || binding.cmArtist !== artist.cmArtist) throw Error("Campaign artist is not bound to frozen queue.");
    add(tiers[binding.tier - 1].counts, artist.counts);
  }
  return tiers.map(({ tier, total, counts }) => ({ tier, ...artistTotals(total, counts) }));
}
export async function readArtistCampaignFiles(root: string, workspace: string) {
  const approval = await json(path.join(root, "approval.json"), true);
  if (!approval) return { progress: null };
  const progress = await json(path.join(root, "progress.json"));
  const chunks = await json(path.join(root, "chunks.json"), true) ?? [];
  let updatedAt = (await stat(path.join(root, "progress.json"))).mtime.toISOString();
  const totals = zero();
  const seen = new Set<string>();
  const artists = new Map<string, ArtistCounts>();
  const includeChunk = async (dir: string) => {
    if (!/^generated-artifacts\/next-saved-full-tiers-1-5-usd100-chunk-\d{3}$/.test(dir))
      throw Error("Unbound campaign checkpoint.");
    const snapshot = await checkpoint(path.join(workspace, dir, "execution/artist-checkpoints.jsonl"));
    for (const [id, artist] of snapshot.artists) {
      if (artists.has(id)) throw Error("Duplicate campaign artist across chunks.");
      artists.set(id, artist); add(totals, artist.counts);
    }
    totals.reserved += snapshot.reserved;
    if (snapshot.updatedAt > updatedAt) updatedAt = snapshot.updatedAt;
  };
  for (const chunk of chunks) {
    if (!/^generated-artifacts\/next-saved-full-tiers-1-5-usd100-chunk-\d{3}$/.test(chunk.dir))
      throw Error("Unbound campaign chunk.");
    if (seen.has(chunk.dir)) throw Error("Duplicate campaign chunk.");
    seen.add(chunk.dir);
    // Even completed scope summaries are row counts, not artist-level evidence.
    // Use the same terminal identity checkpoints for all chunk states.
    await includeChunk(chunk.dir);
  }
  if (progress.activeChunk && !seen.has(progress.activeChunk)) {
    await includeChunk(progress.activeChunk);
  }
  if (totals.reserved > 10000) throw Error("Campaign reservations exceed the approved cap.");
  const headline = progressTotals(count(approval.eligibleArtists), totals, String(progress.status), updatedAt);
  try {
    return { progress: { ...headline, tierBreakdown: await tierProgress(root, approval, artists) } };
  } catch {
    // Tier assignments are optional. Do not turn missing/mismatched assignments
    // into invented zero tiers or discard independently readable headline counts.
    return { progress: { ...headline, tierBreakdownUnavailableReason:
      "Tier details unavailable: frozen queue assignments could not be verified against saved artist identities." } };
  }
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
