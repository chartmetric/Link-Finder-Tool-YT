import {
  SearchProfilesResponse, type BulkBrandRun, type BulkBrandItem, type BulkBrandRunInput, type BulkRunResumeInput,
} from "@workspace/api-zod";
import { validateBulkSelection } from "./bulk-profile-scopes";
import { derivePlatformOutcomes } from "./bulk-platform-outcomes";
import { bulkWorkerId, readArchivedBulkRuns, saveBulkRun } from "./bulk-run-store";
import { bulkOwnership } from "./bulk-ownership-store";
import { BulkError } from "./bulk-ownership";
import { executeBulkRun } from "./bulk-worker";
import { findProfiles, parseKnownProfileUrl, resolveKnownProfileIdentity } from "./musician-search";
import { saveProfileInvestigation } from "./profile-investigations";
import { invalidateMusicianCoverage } from "./musician-coverage";
import { logger } from "./logger";
import { acceptedBulkRequest, withBulkLaunch } from "./bulk-launch-history";
import { prepareBulkRun } from "./bulk-preparation";

export { BulkError } from "./bulk-ownership";

export async function getBulkRun(id: string) {
  return (await bulkOwnership.read(id))[0] ?? (await readArchivedBulkRuns(id))[0];
}
function assertProviders() {
  if (!(process.env.SERPERDEV_API_KEY ?? process.env.SERPER_API_KEY)
    || !process.env.OPENROUTER_API_KEY || !process.env.SCRAPECREATORS_API_KEY) {
    throw new BulkError("Bulk lookup requires Serper, OpenRouter and ScrapeCreators. No paid queue was started.", 503);
  }
}
export async function startBulkRun(requestId: string, input: Omit<BulkBrandRunInput, "requestId" | "continuous"> & { continuous?: boolean }) {
  requestId = requestId.toLowerCase();
  const selection = input;
  const error = validateBulkSelection(selection);
  if (error) throw new BulkError(error, 400);
  const fingerprint = JSON.stringify({
    profileIds: selection.profileIds ? [...selection.profileIds].sort((a, b) => a - b) : undefined,
    profileTypes: selection.profileTypes ?? (selection.scopes ? undefined : ["brand"]),
    scopes: selection.scopes ? [...selection.scopes].sort((a, b) => a.profileType.localeCompare(b.profileType)) : undefined,
    continuous: selection.continuous ?? false, profileLimit: selection.profileLimit,
    workersPerType: selection.workersPerType ?? 1,
    selectionMode: selection.selectionMode === "rerun" ? "rerun" : undefined,
  });
  const existing = (await bulkOwnership.read(requestId))[0];
  if (existing) {
    return (await bulkOwnership.claim(existing, bulkWorkerId, fingerprint)).run;
  }
  assertProviders();
  const scopes = selection.scopes ?? [{ profileType: selection.profileTypes?.[0] ?? "brand", limit: selection.profileIds!.length }];
  const now = new Date().toISOString();
  const initial: BulkBrandRun = {
    id: requestId, status: "running", createdAt: now, updatedAt: now,
    heartbeatAt: now, workerId: bulkWorkerId, resumeVersion: 0,
    workersPerType: selection.workersPerType ?? 1,
    stopRequested: false, estimatedCostUsd: 0,
    selectionMode: selection.selectionMode ?? "remaining",
    scopes,
    preparation: {
      status: "selecting", mode: selection.continuous ? "continuous" : selection.scopes ? "one_chunk" : "manual",
      requested: scopes.reduce((sum, scope) => sum + scope.limit, 0), selected: 0,
      message: "Preparing the profile selection. No paid lookups have started.",
      ...(selection.profileIds ? { profileIds: selection.profileIds } : {}),
      ...(selection.profileLimit !== undefined ? { profileLimit: selection.profileLimit } : {}),
    },
    items: [],
  };
  const run = withBulkLaunch(initial, "start", requestId, selection.launchSource, {
    scopes: initial.scopes!, continuous: !!selection.continuous, workersPerType: initial.workersPerType ?? 1,
    ...(selection.profileIds ? { profileIds: selection.profileIds } : {}),
    ...(selection.continuous ? { profileLimit: selection.profileLimit } : {}),
  });
  const claimed = await bulkOwnership.claim(run, bulkWorkerId, fingerprint);
  if (claimed.launched && claimed.lease) launch(claimed.run, claimed.lease);
  return claimed.run;
}
export async function stopBulkRun(id: string, generation: number) {
  const run = await getBulkRun(id);
  if (!run) throw new BulkError("Bulk run not found.", 404);
  await bulkOwnership.importLegacy(run); // No-op for managed runs; supports saved legacy results.
  return bulkOwnership.stop(id, generation);
}
export async function resumeBulkRun(id: string, input: BulkRunResumeInput) {
  const run = await getBulkRun(id);
  if (!run) throw new BulkError("Bulk run not found.", 404);
  if (acceptedBulkRequest(run, input.requestId)) return run;
  assertProviders();
  await bulkOwnership.importLegacy(run);
  const claimed = await bulkOwnership.claim(run, bulkWorkerId, "", input.resumeVersion, input);
  if (claimed.launched && claimed.lease) launch(claimed.run, claimed.lease);
  return claimed.run;
}
function launch(run: BulkBrandRun, lease: import("./bulk-ownership").Lease) {
  void executeBulkRun(run, lease, {
    ownership: bulkOwnership, processItem, archive: saveBulkRun,
    prepare: (current, checkpoint, signal) => prepareBulkRun(current, lease, checkpoint, signal),
    archiveChunk: async archive => {
      if (!(await readArchivedBulkRuns(archive.id))[0]) await saveBulkRun(archive);
    },
    saveHistory: async item => {
      try {
        item.result!.historyId = await saveProfileInvestigation(item.candidate.url, item.result!);
        invalidateMusicianCoverage();
      } catch (error) {
        item.result!.historySaveError = "Could not add this result to shared investigation history. The bulk-run snapshot contains the result.";
        logger.warn({ err: error, runId: run.id }, "Bulk result could not be added to investigation history");
      }
    },
    warn: error => logger.error({ err: error, runId: run.id }, "Bulk queue stopped safely"),
  }).catch(error => logger.error({ err: error, runId: run.id }, "Bulk queue failed"));
}
async function processItem(item: BulkBrandItem, onProgress: (stage: "searching_platforms" | "verifying_candidates") => void) {
  const parsed = parseKnownProfileUrl(item.candidate.url);
  if (!parsed) throw new Error("The single active account does not have a usable public reference URL.");
  const resolved = await resolveKnownProfileIdentity(
    item.candidate.url, process.env.SCRAPECREATORS_API_KEY!,
    process.env.SERPERDEV_API_KEY ?? process.env.SERPER_API_KEY,
  );
  if (!resolved) throw new Error("Could not resolve the reference account identity; no absence claims were made.");
  const result = SearchProfilesResponse.parse(await findProfiles({
    ...resolved, excludeReferencePlatform: true, methods: ["serper", "gemini"],
    serperApiKey: process.env.SERPERDEV_API_KEY ?? process.env.SERPER_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    scrapeCreatorsApiKey: process.env.SCRAPECREATORS_API_KEY,
    onProgress,
  }));
  item.result = result;
  item.platforms = derivePlatformOutcomes(result, resolved.handlePlatform);
  item.status = "completed";
  item.completedAt = new Date().toISOString();
}
