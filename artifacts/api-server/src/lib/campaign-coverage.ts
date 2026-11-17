import { pool } from "@workspace/db";
import type { MusicianPlatformCoverage } from "@workspace/api-zod";
import { musicianTierSnapshotStatus } from "./musician-instagram-research-coverage";
import { logger } from "./logger";

type Platform = "instagram" | "youtube";
type State = "catalog" | "supported" | "test_likely" | "test_topic" | "candidates" | "no_match" | "failed" | "pending" | "not_searched";
export type CoverageProfile = { profile_id: string; cm_artist: string; tier: number; state: State };
type Membership = { platform: Platform; snapshotAt: string | null; generatedAt: string; testObservedAt?: string | null; profiles: CoverageProfile[] };
export type CampaignCoverage = {
  status: string | null; observedAt: string | null; artists: { profile_id: string; cm_artist: string }[];
};
const campaigns = {
  instagram: { id: "full-tiers-1-5-no-ig-usd100", runs: "instagram_priority_runs", artists: "instagram_priority_artists", channels: "instagram_priority_handles" },
  youtube: { id: "full-tiers-1-5-no-youtube-uncapped", runs: "youtube_link_campaigns", artists: "youtube_link_campaign_artists", channels: "youtube_link_campaign_channels" },
};

export function campaignCoverageSql(platform: Platform) {
  const cfg = campaigns[platform];
  return `SELECT a.profile_id,a.cm_artist,r.status,r.updated_at
    FROM ${cfg.runs} r LEFT JOIN ${cfg.artists} a ON a.campaign_id=r.id
      AND a.status='completed' AND a.checked AND a.likely
      AND a.reason IS DISTINCT FROM 'channel_reused_across_catalog_artists'
      AND NOT EXISTS(SELECT 1 FROM ${cfg.channels} own JOIN ${cfg.channels} other
        ON other.campaign_id=own.campaign_id AND other.channel_id=own.channel_id AND other.profile_id<>own.profile_id
        WHERE own.campaign_id=a.campaign_id AND own.profile_id=a.profile_id)
    WHERE r.id=$1`;
}

async function readCampaign(platform: Platform): Promise<CampaignCoverage> {
  const c = await pool.connect();
  try {
    // A coherent read-only snapshot. Never lock worker rows, claim work, read
    // provider APIs, mutate approvals or import frozen worker code.
    await c.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await c.query("SET LOCAL statement_timeout='8s'");
    const { rows } = await c.query(campaignCoverageSql(platform), [campaigns[platform].id]);
    await c.query("COMMIT");
    if (!rows.length) return { status: null, observedAt: null, artists: [] };
    return { status: rows[0].status, observedAt: new Date(rows[0].updated_at).toISOString(),
      artists: rows.filter(row => row.profile_id !== null).map(row => ({ profile_id: row.profile_id, cm_artist: row.cm_artist })) };
  } catch (error) { await c.query("ROLLBACK"); throw error; }
  finally { c.release(); }
}

export function combineCampaignCoverage(base: Membership, campaign: CampaignCoverage | null,
  now = new Date()): MusicianPlatformCoverage {
  const snapshotStatus = musicianTierSnapshotStatus(base.snapshotAt, now);
  const tiers: MusicianPlatformCoverage["tiers"] = [];
  const valid = snapshotStatus === "current" || snapshotStatus === "recent";
  const likely = new Set(campaign?.artists.map(a => `${a.profile_id}:${a.cm_artist}`) ?? []);
  const seen = new Set<string>();
  for (const p of valid ? base.profiles : []) {
    const tier = Number(p.tier);
    if (!Number.isInteger(tier) || tier < 1 || tier > 5 || !/^\d+$/.test(p.profile_id))
      throw Error("Invalid coverage membership.");
    if (seen.has(p.profile_id)) throw Error("Duplicate artist in catalog coverage membership.");
    seen.add(p.profile_id);
    let row = tiers.find(t => t.tier === tier);
    if (!row) {
      row = { tier, totalProfiles: 0, catalogUrls: 0, supportedResearchUrls: 0, campaignLikelyUrls: 0,
        testLikelyUrls: 0, testTopicUrls: 0,
        unresolvedCandidates: 0, noSupportedMatch: 0, failed: 0, pending: 0, notSearched: 0 };
      tiers.push(row);
    }
    row.totalProfiles++;
    // Exclusive categories prevent catalog/research/campaign overlaps and
    // multiple candidate URLs from increasing the unique-artist denominator.
    if (p.state === "catalog") row.catalogUrls++;
    else if (p.state === "supported") row.supportedResearchUrls++;
    else if (likely.has(`${p.profile_id}:${p.cm_artist}`)) row.campaignLikelyUrls!++;
    else if (p.state === "test_likely") row.testLikelyUrls!++;
    else if (p.state === "test_topic") row.testTopicUrls!++;
    else if (p.state === "candidates") row.unresolvedCandidates++;
    else if (p.state === "no_match") row.noSupportedMatch++;
    else if (p.state === "failed") row.failed++;
    else if (p.state === "pending") row.pending++;
    else if (p.state === "not_searched") row.notSearched++;
    else throw Error("Unknown coverage membership state.");
  }
  const stale = campaign?.status === "running" && campaign.observedAt !== null
    && now.getTime() - Date.parse(campaign.observedAt) > 120_000;
  return { platform: base.platform, snapshotAt: base.snapshotAt, snapshotStatus,
    generatedAt: now.toISOString(), catalogGeneratedAt: base.generatedAt,
    testObservedAt: base.testObservedAt ?? null,
    campaignIncluded: campaign !== null, campaignObservedAt: campaign?.observedAt ?? null,
    campaignStatus: campaign?.status ?? null,
    campaignError: campaign === null ? "Campaign results unavailable; percentages exclude current campaign matches."
      : stale ? "Campaign evidence is stale. Coverage includes the last recorded likely matches." : null,
    tiers: tiers.sort((a, b) => a.tier - b.tier) };
}

export function createCampaignCoverageReader(readMembership: (platform: Platform) => Promise<Membership>,
  read = readCampaign, now = Date.now) {
  const cache = new Map<Platform, { value: MusicianPlatformCoverage; until: number }>();
  const lastCampaign = new Map<Platform, CampaignCoverage>();
  const pending = new Map<Platform, Promise<MusicianPlatformCoverage>>();
  return async (platform: Platform) => {
    const saved = cache.get(platform);
    if (saved && saved.until > now()) return saved.value;
    const current = pending.get(platform);
    if (current) return current;
    const request = (async () => {
      const base = await readMembership(platform);
      let campaign: CampaignCoverage | null = null;
      let failed = false;
      try { campaign = await read(platform); lastCampaign.set(platform, campaign); }
      catch (error) {
        failed = true;
        campaign = lastCampaign.get(platform) ?? null;
        logger.warn({err: error, platform}, "Campaign coverage read failed; retaining last successful campaign membership when available");
      }
      const value = combineCampaignCoverage(base, campaign, new Date(now()));
      if (failed && campaign) value.campaignError = "Campaign refresh unavailable. Coverage includes the last saved likely matches.";
      cache.set(platform, { value, until: now() + 10_000 });
      return value;
    })().finally(() => pending.delete(platform));
    pending.set(platform, request);
    return request;
  };
}
