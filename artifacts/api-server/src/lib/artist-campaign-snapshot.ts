import { artistExportObject } from "./artist-result-storage";
import { CAMPAIGN_ID, CAMPAIGN_QUEUE_SHA256, progressTotals, artistTotals } from "./artist-campaign-model";
import type { ArtistCampaignTierProgress } from "@workspace/api-zod";

export type CampaignSnapshot = {
  version: 1;
  campaignId: string;
  queueSha256: string;
  totalArtists: number;
  processed: number;
  checked: number;
  likely: number;
  reserved: number;
  status: string;
  updatedAt: string;
  capturedAt: string;
  workerEnvironment: "workspace";
  tierBreakdown?: ArtistCampaignTierProgress[];
  tierBreakdownUnavailableReason?: string;
};
const object = () => artistExportObject(`campaign-progress/${CAMPAIGN_ID}.json`);
const unavailableTiers = "Tier details unavailable: frozen queue assignments could not be verified against saved artist identities.";

function snapshotTiers(s: CampaignSnapshot): Pick<CampaignSnapshot, "tierBreakdown" | "tierBreakdownUnavailableReason"> {
  try {
    if (!Array.isArray(s.tierBreakdown) || s.tierBreakdown.length !== 5) throw Error("Missing tier counters.");
    const tiers = s.tierBreakdown.map((t, index) => {
      if (t.tier !== index + 1) throw Error("Invalid tier assignment.");
      return { tier: t.tier, ...artistTotals(t.totalArtists, {
        processed: t.processedArtists, checked: t.checkedArtists, likely: t.likelyMatches, reserved: 0,
      }) };
    });
    for (const [key, expected] of [["totalArtists", s.totalArtists], ["processedArtists", s.processed],
      ["checkedArtists", s.checked], ["likelyMatches", s.likely]] as const) {
      if (tiers.reduce((sum, tier) => sum + tier[key], 0) !== expected) throw Error("Tier totals do not match headline.");
    }
    return { tierBreakdown: tiers };
  } catch {
    // Legacy snapshots and invalid optional tiers keep independently valid
    // headline counters; never substitute invented zero tier rows.
    return { tierBreakdownUnavailableReason: unavailableTiers };
  }
}

export function validateCampaignSnapshot(value: unknown): CampaignSnapshot {
  const s = value as CampaignSnapshot;
  if (!s || s.version !== 1 || s.campaignId !== CAMPAIGN_ID || s.queueSha256 !== CAMPAIGN_QUEUE_SHA256
    || s.workerEnvironment !== "workspace" || typeof s.status !== "string" || !/^[a-z_]{1,60}$/.test(s.status)
    || typeof s.updatedAt !== "string" || typeof s.capturedAt !== "string"
    || !Number.isFinite(Date.parse(s.updatedAt)) || !Number.isFinite(Date.parse(s.capturedAt))
    || Date.parse(s.updatedAt) > Date.parse(s.capturedAt) + 5000
    || !Number.isSafeInteger(s.reserved) || s.reserved < 0 || s.reserved > 10000) {
    throw Error("Shared campaign snapshot is invalid or belongs to another approval.");
  }
  progressTotals(s.totalArtists, { processed: s.processed, checked: s.checked,
    likely: s.likely, reserved: s.reserved }, s.status, s.updatedAt);
  // Allowlist counters only; never persist account evidence, scope queries or credentials.
  return { version: 1, campaignId: s.campaignId, queueSha256: s.queueSha256,
    totalArtists: s.totalArtists, processed: s.processed, checked: s.checked, likely: s.likely,
    reserved: s.reserved, status: s.status, updatedAt: s.updatedAt, capturedAt: s.capturedAt,
    workerEnvironment: s.workerEnvironment, ...snapshotTiers(s) };
}

export function snapshotProgress(value: CampaignSnapshot, now = Date.now()) {
  const s = validateCampaignSnapshot(value);
  const totals = progressTotals(s.totalArtists, {
    processed: s.processed, checked: s.checked, likely: s.likely, reserved: s.reserved,
  }, s.status, s.updatedAt, now);
  const active = ["running", "stop_requested", "preparing"].includes(s.status);
  const stale = active && now - Date.parse(s.updatedAt) > 120_000;
  return { ...totals, campaignId: s.campaignId, queueSha256: s.queueSha256, capturedAt: s.capturedAt,
    workerEnvironment: s.workerEnvironment,
    workerStatus: active ? (stale ? "stale" as const : "recent_activity" as const) : "not_running" as const,
    stale, ...snapshotTiers(s) };
}

export function createCampaignSnapshotStore(getObject = object) {
return {
async load(): Promise<CampaignSnapshot | null> {
  try {
    const file = getObject();
    const [metadata] = await file.getMetadata();
    if (!Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) > 4096 || !metadata.generation)
      throw Error("Shared campaign snapshot exceeds the counter-only limit or has no generation.");
    // Pin to the generation inspected above so size and downloaded bytes agree.
    const [bytes] = await file.bucket.file(file.name, { generation: metadata.generation })
      .download({ validation: "crc32c" });
    return validateCampaignSnapshot(JSON.parse(bytes.toString("utf8")));
  } catch (error: any) {
    if (error.code === 404) return null;
    throw error; // Never turn unreadable/corrupt shared evidence into zero progress.
  }
},

async publish(value: CampaignSnapshot) {
  const s = validateCampaignSnapshot(value);
  const file = getObject();
  let generation: string | number = 0;
  try {
    const [metadata] = await file.getMetadata();
    if (!Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) > 4096 || !metadata.generation)
      throw Error("Shared campaign snapshot exceeds the counter-only limit or has no generation.");
    generation = metadata.generation!;
    const [bytes] = await file.bucket.file(file.name, { generation }).download({ validation: "crc32c" });
    const prior = validateCampaignSnapshot(JSON.parse(bytes.toString("utf8")));
    if (s.totalArtists !== prior.totalArtists || s.processed < prior.processed || s.checked < prior.checked
      || s.likely < prior.likely || s.reserved < prior.reserved
      || Date.parse(s.updatedAt) < Date.parse(prior.updatedAt)
      || Date.parse(s.capturedAt) < Date.parse(prior.capturedAt)) {
      throw Error("Refusing to replace campaign progress with older or conflicting counters.");
    }
  } catch (error: any) {
    if (error.code !== 404) throw error;
  }
  // Atomic replacement, fenced against another observer. No automatic retry on conflict.
  await file.save(JSON.stringify(s), { resumable: false, validation: "crc32c",
    contentType: "application/json", preconditionOpts: { ifGenerationMatch: generation },
    metadata: { cacheControl: "no-store" } });
},
};
}
const store = createCampaignSnapshotStore();
export const loadCampaignSnapshot = store.load;
export const publishCampaignSnapshot = store.publish;
