import {
  SearchProfilesResponse, type BulkBrandRun, type BulkBrandItem, type BulkBrandRunInput,
} from "@workspace/api-zod";
import { listEligibleBrands, MAX_BULK_BATCH } from "./bulk-brand-candidates";
import { commitContinuousArchive, continuousArchive, continuousLimitReached, initialContinuousProgress, nextContinuousChunk } from "./bulk-continuous";
import { runScopedQueue, validateBulkSelection } from "./bulk-profile-scopes";
import { derivePlatformOutcomes } from "./bulk-platform-outcomes";
import { bulkVersion, bulkWorkerId, mergeBulkRunView, readBulkRuns, requestBulkStop, saveBulkRun } from "./bulk-run-store";
import { findProfiles, parseKnownProfileUrl, resolveKnownProfileIdentity } from "./musician-search";
import { saveProfileInvestigation } from "./profile-investigations";
import { invalidateMusicianCoverage } from "./musician-coverage";
import { logger } from "./logger";

const localRuns = new Map<string, BulkBrandRun>();
let activeId: string | undefined;
let storageFailure: string | undefined;
let gate = Promise.resolve();
export class BulkError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const prior = gate;
  let release!: () => void;
  gate = new Promise<void>(resolve => { release = resolve; });
  await prior;
  try { return await work(); } finally { release(); }
}
function remember(run: BulkBrandRun) {
  localRuns.set(run.id, run);
  if (localRuns.size > 30) {
    const oldest = [...localRuns.keys()].find(id => id !== activeId);
    if (oldest) localRuns.delete(oldest);
  }
}
export async function getBulkRun(id: string) {
  let stored: BulkBrandRun | undefined;
  try { stored = (await readBulkRuns(id))[0]; }
  catch (error) {
    const local = localRuns.get(id);
    if (!local) throw error;
    return { ...local, error: `Storage is currently unavailable. Showing in-memory progress; do not close this result until storage recovers. ${local.error ?? ""}` };
  }
  return mergeBulkRunView(localRuns.get(id), stored);
}
async function assertIdle() {
  if (activeId) throw new BulkError("A bulk queue is already active. Stop it or wait before starting another.");
  const active = (await readBulkRuns()).find(run => ["running", "stopping"].includes(run.status));
  if (active) throw new BulkError("Another bulk worker is active. Open its saved run to follow progress.");
}
function assertProviders() {
  if (!(process.env.SERPERDEV_API_KEY ?? process.env.SERPER_API_KEY)
    || !process.env.OPENROUTER_API_KEY || !process.env.SCRAPECREATORS_API_KEY) {
    throw new BulkError("Bulk lookup requires Serper, OpenRouter and ScrapeCreators. No paid queue was started.", 503);
  }
}
export async function startBulkRun(requestId: string, input: (Omit<BulkBrandRunInput, "requestId" | "continuous"> & { continuous?: boolean }) | number[]) {
  return exclusive(async () => {
    const existing = await getBulkRun(requestId);
    if (existing) return existing; // Retrying the same request never starts paid work twice.
    const selection = Array.isArray(input) ? { profileIds: input, continuous: false } : input;
    const selectionError = validateBulkSelection(selection);
    if (selectionError) throw new BulkError(selectionError, 400);
    if (storageFailure) throw new BulkError(storageFailure, 503);
    assertProviders();
    await assertIdle();
    const automatic = selection.scopes ? await initialContinuousProgress(selection.scopes, selection.profileLimit) : undefined;
    const candidates = selection.continuous ? [] : selection.scopes
      ? (await nextContinuousChunk(automatic!, selection.scopes)).candidates
      : (await listEligibleBrands({
        limit: MAX_BULK_BATCH, profileIds: selection.profileIds, eligibleOnly: true,
        profileType: selection.profileTypes?.[0] ?? "brand",
      })).profiles;
    if (!selection.scopes && candidates.length !== selection.profileIds!.length) {
      throw new BulkError("Some selected profiles are no longer eligible for this type. Refresh the selection; no queue was started.");
    }
    if (!selection.continuous && !candidates.length) throw new BulkError("No unattempted profiles with a usable existing link were found in this scan. Continuous mode can scan further; no paid queue was started.");
    const now = new Date().toISOString();
    const run: BulkBrandRun = {
      id: requestId, status: "running", createdAt: now, updatedAt: now,
      heartbeatAt: now, workerId: bulkWorkerId, resumeVersion: bulkVersion(),
      stopRequested: false, estimatedCostUsd: 0,
      scopes: selection.scopes ?? [{ profileType: selection.profileTypes?.[0] ?? "brand", limit: candidates.length }],
      ...(selection.continuous ? { continuous: automatic } : {}),
      items: candidates.map(candidate => ({ candidate, status: "queued", platforms: [] })),
    };
    await saveBulkRun(run); // Persist the queue before launching paid requests.
    launch(run);
    return run;
  });
}
export async function stopBulkRun(id: string) {
  const run = await getBulkRun(id);
  if (!run) throw new BulkError("Bulk run not found.", 404);
  if (!["running", "stopping"].includes(run.status)) return run;
  await requestBulkStop(id); // Separate append-only control event cannot be overwritten by a heartbeat.
  const local = localRuns.get(id);
  if (local) { local.stopRequested = true; local.status = "stopping"; }
  return { ...run, stopRequested: true, status: "stopping" as const };
}
export async function resumeBulkRun(id: string) {
  return exclusive(async () => {
    const run = await getBulkRun(id);
    if (!run) throw new BulkError("Bulk run not found.", 404);
    await assertIdle();
    assertProviders();
    const retry = run.items.filter(item => item.status !== "completed");
    if (!retry.length && (!run.continuous || run.status === "completed")) throw new BulkError("All profiles in this run are already completed.");
    for (const item of retry) {
      item.status = "queued";
      delete item.error;
      delete item.startedAt;
      delete item.completedAt;
      delete item.result;
      item.platforms = [];
    }
    run.status = "running";
    run.stopRequested = false;
    run.heartbeatAt = new Date().toISOString();
    run.workerId = bulkWorkerId;
    run.resumeVersion = bulkVersion();
    delete run.error;
    await saveBulkRun(run);
    storageFailure = undefined;
    launch(run);
    return run;
  });
}
function launch(run: BulkBrandRun) {
  remember(run);
  activeId = run.id;
  void execute(run).catch(error => logger.error({ err: error, runId: run.id }, "Bulk queue failed"));
}
async function processItem(item: BulkBrandItem) {
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
  }));
  item.result = result;
  item.platforms = derivePlatformOutcomes(result, resolved.handlePlatform);
  item.status = "completed";
  item.completedAt = new Date().toISOString();
}
async function execute(run: BulkBrandRun) {
  let heartbeat: Promise<void> | undefined;
  let persistenceError: Error | undefined;
  let writes = Promise.resolve();
  const persist = () => {
    // Serialize lane and heartbeat snapshots; a failed write stops new work.
    writes = writes.then(() => saveBulkRun(run));
    return writes;
  };
  const refreshControl = async () => {
    const persisted = (await readBulkRuns(run.id))[0];
    if (persisted && persisted.resumeVersion >= run.resumeVersion && persisted.workerId !== run.workerId) throw new Error("Worker ownership changed. Queue stopped to avoid duplicate processing.");
    run.stopRequested ||= persisted?.resumeVersion === run.resumeVersion && persisted.stopRequested;
    if (run.stopRequested && ["running", "stopping"].includes(run.status)) run.status = "stopping";
  };
  const timer = setInterval(() => {
    if (heartbeat || persistenceError || !["running", "stopping"].includes(run.status)) return;
    heartbeat = (async () => {
      await refreshControl();
      run.heartbeatAt = new Date().toISOString();
      await persist();
    })().catch(error => {
      persistenceError = error instanceof Error ? error : new Error("Bulk heartbeat could not be saved.");
      run.stopRequested = true;
    }).finally(() => { heartbeat = undefined; });
  }, 15_000);
  timer.unref();
  try {
    for (;;) {
      await runScopedQueue(run.items, async () => {
      await refreshControl();
      return run.stopRequested || !!persistenceError;
    }, async item => {
      item.status = "running";
      item.startedAt = new Date().toISOString();
      run.heartbeatAt = item.startedAt;
      await persist();
      try { await processItem(item); }
      catch (error) {
        item.status = "failed";
        item.error = error instanceof Error ? error.message : "Profile lookup failed.";
        item.completedAt = new Date().toISOString();
        item.platforms = (["Instagram", "TikTok", "YouTube"] as const).map(platform => ({
          platform, status: "incomplete", checkedAt: item.completedAt!, evidenceUrls: [],
          reason: `The investigation failed: ${item.error} Availability was not established.`,
        }));
      }
      run.estimatedCostUsd = (run.continuous?.completedCostUsd ?? 0)
        + run.items.reduce((total, row) => total + (row.result?.estimatedCostUsd ?? 0), 0);
      run.heartbeatAt = new Date().toISOString();
      await persist(); // Persist before this type's next paid profile.
      if (item.result && !item.result.historyId) {
        try {
          item.result.historyId = await saveProfileInvestigation(item.candidate.url, item.result);
          invalidateMusicianCoverage();
        } catch (error) {
          item.result.historySaveError = "Could not add this result to shared investigation history. The bulk-run snapshot contains the result.";
          logger.warn({ err: error, runId: run.id }, "Bulk result could not be added to investigation history");
        }
        await persist();
      }
      if (persistenceError) throw persistenceError;
      });
      if (persistenceError) throw persistenceError;
      await refreshControl();
      if (!run.continuous || run.stopRequested || run.items.some(item => item.status === "queued")) break;
      if (run.items.length) {
        const archive = continuousArchive(run);
        // Do not overwrite an existing archive, including an explicit retry that
        // finished after a crash but before this coordinator was resumed.
        if (!(await readBulkRuns(archive.id))[0]) await saveBulkRun(archive);
        commitContinuousArchive(run);
        await persist();
      }
      if (run.continuous.cursors.every(cursor => cursor.exhausted) || continuousLimitReached(run.continuous)) break;
      const next = await nextContinuousChunk(run.continuous, run.scopes!);
      run.continuous.cursors = next.cursors;
      run.items = next.candidates.map(candidate => ({ candidate, status: "queued", platforms: [] }));
      run.heartbeatAt = new Date().toISOString();
      await persist(); // Freeze cursor + chunk before any new paid work.
    }
    if (heartbeat) await heartbeat;
    if (persistenceError) throw persistenceError;
    run.status = run.items.some(item => item.status === "queued")
      || (run.continuous && (run.stopRequested || (!continuousLimitReached(run.continuous) && !run.continuous.cursors.every(cursor => cursor.exhausted))))
      ? "stopped" : "completed";
    await persist();
  } catch (error) {
    run.status = "stopped";
    run.error = error instanceof Error ? error.message : "Bulk queue stopped unexpectedly.";
    storageFailure = `The previous queue stopped before it could safely continue: ${run.error}. Resolve the error and explicitly resume it.`;
    logger.error({ err: error, runId: run.id }, "Bulk queue stopped safely");
    try { await saveBulkRun(run); } catch { /* Visible in-memory state retains the unsaved result and warning. */ }
  } finally {
    clearInterval(timer);
    if (heartbeat) await heartbeat;
    if (activeId === run.id) activeId = undefined;
  }
}
