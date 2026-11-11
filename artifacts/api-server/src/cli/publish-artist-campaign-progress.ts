import { setTimeout as delay } from "node:timers/promises";
import { CAMPAIGN_ID, CAMPAIGN_QUEUE_SHA256, captureArtistCampaignSnapshot, workspaceRoot } from "../lib/artist-campaign-progress";
import { publishCampaignSnapshot } from "../lib/artist-campaign-snapshot";
import { logger } from "../lib/logger";
import { captureTierPrioritySnapshot } from "../lib/instagram-tier-priority-progress";

// An independent, read-only observer: never import campaign executors, provider
// clients, budget coordinators or admission code. Never launched by the API.
async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--publish")
    || !args.includes(`--campaign-id=${CAMPAIGN_ID}`)
    || !args.includes(`--queue-sha256=${CAMPAIGN_QUEUE_SHA256}`)
    || args.some(arg => !["--publish", "--watch", `--campaign-id=${CAMPAIGN_ID}`,
      `--queue-sha256=${CAMPAIGN_QUEUE_SHA256}`].includes(arg))) {
    throw Error("Explicit --publish, approved --campaign-id and --queue-sha256 are required.");
  }
  const workspace = await workspaceRoot();
  let stopped = false;
  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    stopped = true; abort.abort();
  });
  do {
    try {
      const snapshot = await captureTierPrioritySnapshot(workspace) ?? await captureArtistCampaignSnapshot(workspace);
      await publishCampaignSnapshot(snapshot);
      logger.info({ campaignId: snapshot.campaignId, processedArtists: snapshot.processed,
        totalArtists: snapshot.totalArtists, updatedAt: snapshot.updatedAt,
        capturedAt: snapshot.capturedAt, maximumSpendCents: snapshot.maximumSpendCents },
      "Shared campaign counters saved; no paid work performed");
    } catch (error) {
      if (!args.includes("--watch")) throw error;
      // A transient partial file/storage read must not kill the independent
      // observer. Leave the last shared snapshot intact until a readable cycle.
      logger.warn({ err: error }, "Campaign snapshot unavailable; previous counters retained; no paid work performed");
    }
    if (!args.includes("--watch") || stopped) break;
    await delay(15_000, undefined, { signal: abort.signal }).catch(error => {
      if (error.name !== "AbortError") throw error;
    });
  } while (!stopped);
}
main().catch(() => {
  logger.error("Campaign progress observer stopped. Shared counters were not replaced; no paid work was started or retried.");
  process.exitCode = 1;
});
