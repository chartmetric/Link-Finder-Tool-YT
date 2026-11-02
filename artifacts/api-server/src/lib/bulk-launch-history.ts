import type { BulkAcceptedSettings, BulkBrandRun, BulkLaunchEvent, BulkLaunchSource } from "@workspace/api-zod";

/** IDs are compared as UUIDs, not case-sensitive labels. No client actor data is stored. */
export function acceptedBulkRequest(run: BulkBrandRun, requestId: string) {
  return run.id.toLowerCase() === requestId.toLowerCase()
    || !!run.launchHistory?.some(event => event.requestId.toLowerCase() === requestId.toLowerCase());
}

/** Detached values keep later progress, retries and chunk rotation from rewriting history.
 * History travels in the application's append-only snapshots, never catalog records. */
export function withBulkLaunch(
  run: BulkBrandRun, action: BulkLaunchEvent["action"], requestId: string,
  source: BulkLaunchSource | undefined, startSettings?: BulkAcceptedSettings,
): BulkBrandRun {
  const settings: BulkAcceptedSettings = startSettings ?? {
    scopes: run.scopes ?? [],
    continuous: !!run.continuous,
    workersPerType: run.workersPerType ?? 1,
    ...(run.continuous ? {
      profileLimit: run.continuous.profileLimit,
      upperProfileId: run.continuous.upperProfileId,
    } : {
      profileIds: run.items.map(item => item.candidate.profileId),
    }),
  };
  return {
    ...run,
    launchHistory: [...(run.launchHistory ?? []), {
      action, requestId: requestId.toLowerCase(), source: source ?? "unknown",
      acceptedAt: new Date().toISOString(),
      chunkNumber: (run.continuous?.batches ?? 0) + 1,
      settings: structuredClone(settings),
    }],
  };
}
