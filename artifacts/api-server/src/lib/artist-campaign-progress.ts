import { access, readFile, open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ArtistCampaignTierProgress } from "@workspace/api-zod";
import { loadCampaignSnapshot, snapshotProgress } from "./artist-campaign-snapshot";
import { CAMPAIGN_ID, CAMPAIGN_QUEUE_SHA256, CAMPAIGN_DIRECTORY, checkpointCounts,
  progressTotals, artistTotals, count, zero, type Counts } from "./artist-campaign-model";
export { CAMPAIGN_ID, CAMPAIGN_QUEUE_SHA256, checkpointCounts, progressTotals } from "./artist-campaign-model";
type ArtistCounts = { cmArtist: string; counts: Counts };
export async function workspaceRoot() {
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
async function spendingApproval(root: string, original: any, progress: any) {
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  if (progress.maximumSpendCents !== null) return { maximumSpendCents: 10000, authorizationSha256: digest(original) };
  const uncapped = await json(path.join(root, "uncapped-approval.json"));
  if (uncapped.uncappedExplicitlyApproved !== true || uncapped.maximumSpendCents !== null
    || uncapped.originalApprovalSha256 !== digest(original)
    || uncapped.id !== original.id || uncapped.queueSha256 !== original.queueSha256
    || uncapped.eligibleArtists !== original.eligibleArtists)
    throw Error("Uncapped spending approval could not be verified.");
  return { maximumSpendCents: null, authorizationSha256: digest(uncapped) };
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
export async function readArtistCampaignFiles(root: string, workspace: string): Promise<{
  progress: (ReturnType<typeof progressTotals> & {
    tierBreakdown?: ArtistCampaignTierProgress[];
    tierBreakdownUnavailableReason?: string;
  }) | null;
}> {
  const approval = await json(path.join(root, "approval.json"), true);
  if (!approval) return { progress: null };
  const progress = await json(path.join(root, "progress.json"));
  const spending = await spendingApproval(root, approval, progress);
  const chunks = await json(path.join(root, "chunks.json"), true) ?? [];
  let updatedAt = (await stat(path.join(root, "progress.json"))).mtime.toISOString();
  const totals = zero();
  const seen = new Set<string>();
  const artists = new Map<string, ArtistCounts>();
  const observedIdentities = new Map<string, string>();
  const includeChunk = async (dir: string) => {
    if (!/^generated-artifacts\/next-saved-full-tiers-1-5-usd100-chunk-\d{3}$/.test(dir))
      throw Error("Unbound campaign checkpoint.");
    const snapshot = await checkpoint(path.join(workspace, dir, "execution/artist-checkpoints.jsonl"));
    for (const [id, artist] of snapshot.artists) {
      if (observedIdentities.has(id) && observedIdentities.get(id) !== artist.cmArtist)
        throw Error("Campaign artist identity changed across chunks.");
      observedIdentities.set(id, artist.cmArtist);
      // Interrupted chunks retain untouched scope placeholders. They may occur
      // again in a continuation but are neither processed nor a second verdict.
      if (artist.counts.processed === 0) continue;
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
  const headline = progressTotals(count(approval.eligibleArtists), totals, String(progress.status), updatedAt,
    Date.now(), spending.maximumSpendCents);
  try {
    return { progress: { ...headline, tierBreakdown: await tierProgress(root, approval, artists) } };
  } catch {
    // Tier assignments are optional. Do not turn missing/mismatched assignments
    // into invented zero tiers or discard independently readable headline counts.
    return { progress: { ...headline, tierBreakdownUnavailableReason:
      "Tier details unavailable: frozen queue assignments could not be verified against saved artist identities." } };
  }
}

// Only the explicitly launched observer reads local files. Bind the entire
// approved queue before mirroring counters; never start or retry paid work.
export async function captureArtistCampaignSnapshot(workspace: string) {
  const root = path.join(workspace, CAMPAIGN_DIRECTORY);
  const approval = await json(path.join(root, "approval.json"));
  const queue = await json(path.join(root, "queue.json"));
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const claimed = await json(path.join(root, "claimed.json"));
  if (approval.id !== CAMPAIGN_ID || approval.queueSha256 !== CAMPAIGN_QUEUE_SHA256
    || digest(queue) !== approval.queueSha256 || queue.length !== approval.eligibleArtists
    || approval.maximumSpendCents !== 10000 || claimed.id !== approval.id
    || claimed.scopeSha256 !== digest(approval)) throw Error("Campaign approval or queue binding changed.");
  const result = await readArtistCampaignFiles(root, workspace);
  if (!result.progress) throw Error("Approved campaign progress is missing.");
  const p = result.progress;
  const spending = await spendingApproval(root, approval, await json(path.join(root, "progress.json")));
  if (p.maximumSpendUsd !== (spending.maximumSpendCents === null ? null : spending.maximumSpendCents / 100))
    throw Error("Campaign spending approval changed during capture.");
  return {
    version: 2 as const, ...spending, campaignId: approval.id as string, queueSha256: approval.queueSha256 as string,
    totalArtists: p.totalArtists, processed: p.processedArtists, checked: p.checkedArtists,
    likely: p.likelyMatches, reserved: Math.round(p.reservedUsd * 100),
    status: p.status, updatedAt: p.updatedAt, capturedAt: new Date().toISOString(),
    workerEnvironment: "workspace" as const, tierBreakdown: p.tierBreakdown,
    tierBreakdownUnavailableReason: p.tierBreakdownUnavailableReason,
  };
}

export function createCampaignProgressReader(load = loadCampaignSnapshot, now = Date.now) {
  let cached: { at: number; value: Awaited<ReturnType<typeof load>> } | undefined;
  let pending: ReturnType<typeof load> | undefined;
  return async () => {
    if (!cached || now() - cached.at >= 4000) {
      pending ??= load().then(value => {
        cached = { at: now(), value }; return value;
      }).finally(() => { pending = undefined; });
      await pending;
    }
    return { progress: cached!.value ? snapshotProgress(cached!.value, now()) : null };
  };
}
export const readArtistCampaignProgress = createCampaignProgressReader();
