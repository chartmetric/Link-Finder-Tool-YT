// Read-only indexed review. No worker imports, runtime files, provider calls,
// catalog writes, admissions or migrations.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import type { ArtistResultBatch, ArtistResultRow } from "@workspace/api-zod";
import { artistExportObject } from "./artist-result-storage";
import { YOUTUBE_CAMPAIGN_ID as campaignId, youtubeDigest } from "./youtube-artist-progress-model";
import { youtubeRow, youtubeResultId, type ArchivedArtist, type CampaignArtist } from "./youtube-campaign-results-model";
export { youtubeResultId };

const artistColumns = "profile_id,cm_artist,artist,tier,status,reason,result_sha256,candidates,checked,likely,ordinal";
type IndexedArtist = CampaignArtist & { ordinal: number };
type Receipt = { profile_id: string; operation_key: string; receipt_sha256: string };
type Campaign = { status: string; scope_sha256: string; approval_sha256: string; reserved_cents: string; updated_at: Date; total_artists: number };
const filters: Record<string, string> = {
  all: "true", likely: "a.status='completed' AND a.likely AND a.reason IS DISTINCT FROM 'channel_reused_across_catalog_artists'",
  checked_not_accepted: "a.status='completed' AND a.checked AND NOT a.likely AND a.reason IS DISTINCT FROM 'channel_reused_across_catalog_artists'",
  shared_handle: `(a.reason='channel_reused_across_catalog_artists' OR EXISTS(
    SELECT 1 FROM youtube_link_campaign_channels own JOIN youtube_link_campaign_channels other
      ON other.campaign_id=own.campaign_id AND other.channel_id=own.channel_id AND other.profile_id!=own.profile_id
      WHERE own.campaign_id=a.campaign_id AND own.profile_id=a.profile_id))`,
  no_channel: "a.status='completed' AND a.candidates=0",
  pending: "(a.status='in_progress' OR (a.status='completed' AND NOT a.checked AND a.candidates>0))",
  deferred: "a.status='deferred'", failed: "a.status='failed'", queued: "a.status='queued'",
};
export function youtubeIndexedFilter(search: string, filter: string) {
  assert.ok(search.length <= 120 && Object.hasOwn(filters, filter), "Invalid YouTube artist filters.");
  const term = `%${search.trim().toLowerCase().replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
  return {
    sql: `a.campaign_id=$1 AND (${filters[filter]}) AND ($2='%%' OR lower(a.artist) LIKE $2 ESCAPE '!'
      OR a.profile_id LIKE $2 ESCAPE '!' OR a.cm_artist LIKE $2 ESCAPE '!' OR EXISTS(
        SELECT 1 FROM youtube_link_campaign_channels ch WHERE ch.campaign_id=a.campaign_id AND ch.profile_id=a.profile_id
        AND lower(ch.channel_id) LIKE $2 ESCAPE '!'))`,
    term,
  };
}
let archiveReads = 0;
const waiters: (() => void)[] = [];
export async function readYoutubeArchive(name: string, expectedHash?: string): Promise<any> {
  assert.match(name, /^(?:approval\.json|(?:artists|metadata|receipts)\/[a-zA-Z0-9_-]+\.json)$/);
  if (archiveReads >= 6) await new Promise<void>(resolve => waiters.push(resolve)); else archiveReads++;
  try {
    const file = artistExportObject(`youtube-campaign-archive/${campaignId}/${name}`);
    const [meta] = await file.getMetadata();
    assert.ok(meta.generation && Number.isSafeInteger(Number(meta.size)) && Number(meta.size) <= 40 * 1024 * 1024);
    const [bytes] = await file.bucket.file(file.name, { generation: meta.generation }).download({ validation: "crc32c" });
    assert.equal(createHash("sha256").update(bytes).digest("hex"), meta.metadata?.sha256, "Archive bytes changed.");
    const value = JSON.parse(bytes.toString("utf8"));
    if (expectedHash) assert.equal(youtubeDigest(value), expectedHash, "Archive differs from committed evidence.");
    return value;
  } finally { const next = waiters.shift(); if (next) next(); else archiveReads--; }
}
// Only absent, not-yet-mirrored objects are optional. Corruption and access
// failures remain fatal. Injection supports fully offline publication-lag tests.
export async function optionalYoutubeArchive(name: string, hash: string | undefined, missing: string[],
  read = readYoutubeArchive) {
  try { return await read(name, hash); }
  catch (e: any) { if (e.code !== 404) throw e; missing.push(name); return null; }
}
export async function loadYoutubeArtistRows(a: CampaignArtist, receipts: Receipt[], conflicts: Map<string, string[]>,
  observedAt: string, read = readYoutubeArchive): Promise<ArtistResultRow[]> {
  assert.match(a.profile_id, /^\d+$/);
  const missing: string[] = [];
  const record: ArchivedArtist | null = a.status === "completed"
    ? await optionalYoutubeArchive(`artists/${a.profile_id}.json`, a.result_sha256 ?? undefined, missing, read) : null;
  if (record) {
    assert.ok(a.result_sha256);
    assert.equal(record.artist.profileId, a.profile_id); assert.equal(record.artist.cmArtist, a.cm_artist);
    assert.equal(record.candidates.length, a.candidates);
  }
  const metadata = record ? await optionalYoutubeArchive(`metadata/${a.profile_id}.json`, undefined, missing, read) : null;
  const packets: Record<string, any>[] = [];
  for (const r of receipts) {
    const packet = await optionalYoutubeArchive(`receipts/${youtubeDigest(r.operation_key)}.json`, r.receipt_sha256, missing, read);
    if (packet) { assert.equal(packet.operationKey, r.operation_key); packets.push(packet); }
  }
  return (record?.candidates.length ? record.candidates : [null]).map((candidate, i) => {
    const row = youtubeRow(a, candidate, i, conflicts.get(candidate?.capture?.body?.channelId ?? "") ?? [], observedAt, record ?? undefined);
    const hash = candidate ? youtubeDigest(candidate.url) : "";
    const extra: Record<string, unknown> = {
      "Available artist metadata (JSON)": metadata,
      "Search receipt (JSON)": packets.find(p => p.operationKey === `search-${a.profile_id}`),
      "Channel receipt (JSON)": packets.find(p => p.operationKey === `channel-${a.profile_id}-${hash}`),
      "Exact model request and response receipt (JSON)": packets.find(p => p.operationKey === `model-${a.profile_id}-${hash}`),
      "All committed returned receipts for artist (JSON)": packets,
    };
    row.fields = row.fields.map(f => f.label in extra ? { ...f, value: extra[f.label] == null ? "" : JSON.stringify(extra[f.label]) }
      : f.label === "Archive availability" && missing.length ? { ...f, value: `${f.value} Missing archived files (publication may still be catching up): ${JSON.stringify(missing)}. No paid retry.` } : f);
    return row;
  });
}
function batch(c: Campaign, counts: any, observedAt: string): ArtistResultBatch {
  return { id: youtubeResultId, title: "YouTube continuous campaign · Tier 1–5", source: "research",
    createdAt: c.updated_at.toISOString(), status: c.status,
    artistCount: counts.artist_count, candidateCount: counts.candidate_count, rowCount: counts.row_count,
    verifiedCount: 0, reviewCount: counts.likely_count, notInspectedCount: counts.unchecked_count,
    metadataFailedCount: 0, noCandidateCount: counts.no_channel_count, reservedUsd: Number(c.reserved_cents) / 100, reportedUsd: null,
    explanation: "Read-only YouTube evidence. Filters select artists, and show every saved candidate for those artists, including other outcomes. Likely suggestions are not verified or accepted links. Current coordinator holds override archived positives. Queued, deferred, failed and pending artists remain visible. Missing archive files are explicitly unavailable, never invented rejections.",
    metrics: [{ label: "Current holds observed at", value: observedAt }],
    details: [{ label: "Frozen scope SHA256", value: c.scope_sha256, group: "provenance" },
      { label: "Spending", value: "Reservations are not invoices. No total cap; reading or downloading never authorizes spending.", group: "provenance" }] };
}
const countSql = `SELECT count(*)::int artist_count,coalesce(sum(candidates),0)::int candidate_count,
  coalesce(sum(greatest(1,candidates)),0)::int row_count,
  count(*) FILTER(WHERE status='completed' AND likely AND reason IS DISTINCT FROM 'channel_reused_across_catalog_artists')::int likely_count,
  count(*) FILTER(WHERE NOT checked AND candidates>0)::int unchecked_count,
  count(*) FILTER(WHERE status='completed' AND candidates=0)::int no_channel_count
  FROM youtube_link_campaign_artists WHERE campaign_id=$1`;
async function session() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await c.query("SET LOCAL statement_timeout='10s'");
    const campaign: Campaign | undefined = (await c.query(`SELECT status,scope_sha256,approval_sha256,reserved_cents,updated_at,total_artists
      FROM youtube_link_campaigns WHERE id=$1`, [campaignId])).rows[0];
    if (!campaign) { await c.query("COMMIT"); c.release(); return null; }
    const counts = (await c.query(countSql, [campaignId])).rows[0];
    const observedAt = new Date().toISOString();
    return {
      batch: batch(campaign, counts, observedAt),
      async validate() {
        const approval = await readYoutubeArchive("approval.json", campaign.approval_sha256);
        assert.equal(approval.scopeSha256, campaign.scope_sha256);
        assert.equal(approval.totalArtists, campaign.total_artists);
        assert.equal(counts.artist_count, campaign.total_artists);
      },
      async selected(offset: number, limit: number, search: string, filter: string) {
        const where = youtubeIndexedFilter(search, filter);
        const total = (await c.query(`SELECT count(*)::int n FROM youtube_link_campaign_artists a WHERE ${where.sql}`,
          [campaignId, where.term])).rows[0].n as number;
        const artists: IndexedArtist[] = (await c.query(`SELECT ${artistColumns} FROM youtube_link_campaign_artists a
          WHERE ${where.sql} ORDER BY ordinal LIMIT $3 OFFSET $4`, [campaignId, where.term, limit, offset])).rows;
        return { total, artists };
      },
      async after(ordinal: number) {
        return (await c.query(`SELECT ${artistColumns} FROM youtube_link_campaign_artists
          WHERE campaign_id=$1 AND ordinal>$2 ORDER BY ordinal LIMIT 250`, [campaignId, ordinal])).rows as IndexedArtist[];
      },
      async rows(artists: IndexedArtist[]) {
        const ids = artists.filter(a => a.status !== "queued").map(a => a.profile_id);
        const receipts: Receipt[] = ids.length ? (await c.query(`SELECT profile_id,operation_key,receipt_sha256 FROM youtube_link_campaign_admissions
          WHERE campaign_id=$1 AND profile_id=ANY($2::text[]) AND status='returned'`, [campaignId, ids])).rows : [];
        const shared = ids.length ? (await c.query(`SELECT own.channel_id,array_agg(DISTINCT other.profile_id) profiles
          FROM youtube_link_campaign_channels own JOIN youtube_link_campaign_channels other
          ON other.campaign_id=own.campaign_id AND other.channel_id=own.channel_id
          WHERE own.campaign_id=$1 AND own.profile_id=ANY($2::text[])
          GROUP BY own.channel_id HAVING count(DISTINCT other.profile_id)>1`, [campaignId, ids])).rows : [];
        const conflicts = new Map<string, string[]>(shared.map(r => [r.channel_id, r.profiles]));
        const result: ArtistResultRow[][] = new Array(artists.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(6, artists.length) }, async () => {
          while (next < artists.length) {
            const i = next++, a = artists[i];
            result[i] = await loadYoutubeArtistRows(a, receipts.filter(r => r.profile_id === a.profile_id), conflicts, observedAt);
          }
        }));
        return result.flat();
      },
      async close() { try { await c.query("ROLLBACK"); } finally { c.release(); } },
    };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); c.release(); throw e; }
}
export async function youtubeResultsSummary() {
  const s = await session(); if (!s) return null;
  try { return s.batch; } finally { await s.close(); }
}
export async function youtubeResultsPage(offset: number, limit: number, search: string, filter: string, open = session) {
  assert.ok(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 50);
  youtubeIndexedFilter(search, filter);
  const s = await open(); if (!s) return null;
  try {
    await s.validate();
    const { total, artists } = await s.selected(offset, limit, search, filter);
    return { batch: s.batch, rows: await s.rows(artists), total, pageArtistCount: artists.length,
      nextOffset: offset + artists.length < total ? offset + artists.length : null };
  } finally { await s.close(); }
}
export async function* youtubeResultsExport(open = session) {
  // Keyset pagination and one read-only transaction retain a consistent hold
  // observation without loading the frozen queue or every completed archive.
  const s = await open(); if (!s) throw Error("YouTube campaign not found.");
  try {
    await s.validate();
    let ordinal = -1;
    while (true) {
      const artists = await s.after(ordinal); if (!artists.length) break;
      for (let i = 0; i < artists.length; i += 25)
        yield { batch: s.batch, rows: await s.rows(artists.slice(i, i + 25)) };
      ordinal = artists.at(-1)!.ordinal;
    }
  } finally { await s.close(); }
}
