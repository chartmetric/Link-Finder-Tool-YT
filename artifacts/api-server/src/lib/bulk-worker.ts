import type { BulkBrandItem, BulkBrandRun } from "@workspace/api-zod";
import { BulkOwnership, type Lease } from "./bulk-ownership";
import { withPaidRequestGuard } from "./paid-request-guard";
import { runScopedQueue } from "./bulk-profile-scopes";
import { advanceItemStage, clearItemStage } from "./bulk-item-progress";
import { commitContinuousArchive, continuousArchive, continuousLimitReached, nextContinuousChunk } from "./bulk-continuous";
import { observePreparationRead, PreparationReadError, withPreparationDiagnostics } from "./bulk-preparation-diagnostics";
import type { ProviderCreditError } from "./provider-credit-error";

export type WorkerDependencies = {
  ownership: BulkOwnership;
  processItem: (item: BulkBrandItem, progress: (stage: "searching_platforms" | "verifying_candidates") => void) => Promise<void>;
  archive: (run: BulkBrandRun) => Promise<void>;
  archiveChunk?: (run: BulkBrandRun) => Promise<void>;
  nextChunk?: typeof nextContinuousChunk;
  saveHistory: (item: BulkBrandItem) => Promise<void>;
  warn: (error: unknown) => void;
  prepare?: (run: BulkBrandRun, checkpoint: () => Promise<void>, signal: AbortSignal) => Promise<boolean>;
};

/** Only an explicit successful claim launches work; all lanes share its fence. */
export async function executeBulkRun(run: BulkBrandRun, lease: Lease, deps: WorkerDependencies) {
  let heartbeat: Promise<void> | undefined;
  let failure: unknown;
  let preparingPhase = false;
  let writes = Promise.resolve();
  let creditFailure: ProviderCreditError | undefined;
  let creditStop: Promise<void> | undefined;
  const preparationAbort = new AbortController();
  const stopPreparation = () => preparationAbort.abort(new Error(
    "Stopped during profile selection. Catalog reads cancelled; server cancellation is best effort with a 40-second execution deadline. No paid requests were started.",
  ));
  const unsubscribe = deps.ownership.onStop(lease, () => {
    run.stopRequested = true;
    stopPreparation();
  });
  let preparationPoll: ReturnType<typeof setInterval> | undefined;
  let polling: Promise<void> | undefined;
  const guard = async () => {
    if (failure) throw failure;
    await deps.ownership.guard(lease);
  };
  const timer = setInterval(() => {
    if (heartbeat || failure) return;
    heartbeat = deps.ownership.renew(lease).then(stop => {
      run.stopRequested ||= stop;
      if (stop) stopPreparation();
    }).catch(error => { failure = error; preparationAbort.abort(error); }).finally(() => { heartbeat = undefined; });
  }, 15_000);
  timer.unref();
  const persist = (acknowledgedIndex?: number, release = false) => {
    // Serialize archive delivery and all lane/stage snapshots as well as fencing
    // them in PostgreSQL. A failed write blocks every subsequent dispatch.
    writes = writes.then(async () => {
      const saved = await deps.ownership.save(lease, run, acknowledgedIndex, release);
      run.stopRequested = saved.stopRequested;
      run.updatedAt = saved.updatedAt;
      run.heartbeatAt = saved.heartbeatAt;
      // Selection checkpoints live in the transactional coordinator. Do not
      // append empty snapshots over a legacy archive before checking its ID.
      if (saved.preparation?.status !== "selecting") await deps.archive(saved);
    }).catch(error => {
      failure = error;
      run.stopRequested = true;
      throw error;
    });
    return writes;
  };
  const stopForCredit = (error: ProviderCreditError) => {
    if (!creditFailure) {
      // Close the local dispatch gate synchronously, then commit the Stop under
      // this generation. Existing admissions/results remain fenced and saved.
      creditFailure = error;
      run.error = error.message;
      run.stopRequested = true;
      run.status = "stopping";
      creditStop = deps.ownership.stop(run.id, lease.token).then(() => persist()).catch(error => {
        failure = error;
        throw error;
      });
    }
    return creditStop!;
  };
  const paidGuard = async () => {
    await guard();
    if (creditFailure) throw creditFailure;
  };
  try {
    if (run.preparation?.status === "selecting") {
      preparingPhase = true;
      if (!deps.prepare) throw new Error("This worker cannot prepare the run. No paid requests were started.");
      // Other replicas cannot receive local notifications. Poll only while
      // preparing, with at most one coordinator read in flight.
      preparationPoll = setInterval(() => {
        if (polling || preparationAbort.signal.aborted) return;
        polling = deps.ownership.renew(lease).then(stop => {
          run.stopRequested ||= stop;
          if (stop) stopPreparation();
        }).catch(error => {
          failure = error;
          preparationAbort.abort(error);
        }).finally(() => { polling = undefined; });
      }, 1_000);
      preparationPoll.unref();
      const proceed = await withPreparationDiagnostics(run, async () => {
        const ready = await deps.prepare!(run, async () => {
          preparationAbort.signal.throwIfAborted();
          await guard();
          run.stopRequested ||= await deps.ownership.renew(lease);
          if (run.stopRequested) throw new Error("Stopped during profile selection. No paid requests were started.");
          await persist();
        }, preparationAbort.signal);
        clearInterval(preparationPoll);
        if (polling) await polling;
        if (!ready) return false;
        await observePreparationRead("coordinator_checkpoint", async () => {
          await guard();
          run.stopRequested ||= await deps.ownership.renew(lease);
          await persist(); // Full ready queue archived before any paid admission.
        });
        return true;
      });
      if (!proceed) return; // Legacy request restored and its lease released.
      preparingPhase = false;
    }
    for (;;) {
      const indices = new Map(run.items.map((item, index) => [item, index]));
      await runScopedQueue(run.items.filter(item => item.status === "queued"), async () => {
        await guard();
        run.stopRequested ||= await deps.ownership.renew(lease);
        return run.stopRequested;
      }, async item => {
        if (creditFailure || run.stopRequested) return;
        const index = indices.get(item)!;
        if (!await deps.ownership.admit(lease, index)) { run.stopRequested = true; return; }
        item.status = "running";
        item.startedAt = new Date().toISOString();
        advanceItemStage(item, "reading_reference");
        await persist();
        try {
          await withPaidRequestGuard(paidGuard, () => deps.processItem(item, stage => {
            if (!advanceItemStage(item, stage) || failure) return;
            void persist().catch(error => { failure = error; run.stopRequested = true; });
          }), stopForCredit);
        } catch (error) {
          // A lost lease must leave its admission uncertain, never acknowledged.
          await guard();
          item.status = "failed";
          item.error = error instanceof Error ? error.message : "Profile lookup failed.";
          item.completedAt = new Date().toISOString();
          item.platforms = (["Instagram", "TikTok", "YouTube"] as const).map(platform => ({
            platform, status: "incomplete", checkedAt: item.completedAt!, evidenceUrls: [],
            reason: `The investigation failed: ${item.error} Availability was not established.`,
          }));
        }
        await guard();
        clearItemStage(item);
        run.estimatedCostUsd = (run.continuous?.completedCostUsd ?? 0)
          + run.items.reduce((total, row) => total + (row.result?.estimatedCostUsd ?? 0), 0);
        await persist(index);
        if (item.result && !item.result.historyId) {
          await guard();
          await deps.saveHistory(item);
          await persist();
        }
      }, run.workersPerType ?? 1);
      await writes;
      await guard();
      run.stopRequested ||= await deps.ownership.renew(lease);
      if (!run.continuous || run.stopRequested || run.items.some(item => item.status === "queued")) break;
      if (run.items.length) {
        // Archive first, then atomically clear the current chunk/admission indices.
        // A crash repeats only the deterministic archive, never paid providers.
        await (deps.archiveChunk ?? deps.archive)(continuousArchive(run));
        await guard();
        commitContinuousArchive(run);
        const cleared = await deps.ownership.clearChunk(lease, run);
        run.stopRequested = cleared.stopRequested;
        await persist();
      }
      if (run.stopRequested || run.continuous.cursors.every(cursor => cursor.exhausted) || continuousLimitReached(run.continuous)) break;
      const next = await (deps.nextChunk ?? nextContinuousChunk)(run.continuous, run.scopes!);
      await guard();
      run.continuous.cursors = next.cursors;
      run.items = next.candidates.map(candidate => ({ candidate, status: "queued", platforms: [] }));
      await persist(); // Cursor + complete chunk are durable before admission.
    }
    clearInterval(timer);
    if (heartbeat) await heartbeat;
    await guard();
    run.status = !!creditFailure || (run.stopRequested && run.preparation?.status === "selecting") || run.items.some(item => item.status === "queued")
      || (run.continuous && (run.stopRequested || (!continuousLimitReached(run.continuous) && !run.continuous.cursors.every(cursor => cursor.exhausted))))
      ? "stopped" : "completed";
    await persist(undefined, true);
  } catch (error) {
    clearInterval(timer);
    clearInterval(preparationPoll);
    if (heartbeat) await heartbeat;
    if (polling) await polling;
    run.status = "stopped";
    const preparing = preparingPhase || run.preparation?.status === "selecting";
    const preparationError = preparationAbort.signal.aborted && run.stopRequested
      ? "Stopped during profile selection. Catalog reads cancelled; server cancellation is best effort with a 40-second execution deadline. Paid admissions occurred: no."
      : error instanceof PreparationReadError ? error.message : "Preparation validation or coordination failed. Paid admissions occurred: no.";
    run.error = preparing
      ? `Profile preparation stopped: ${preparationError} No paid provider requests were started. You can explicitly resume this saved run.`
      : error instanceof Error ? error.message : "Bulk queue stopped unexpectedly.";
    deps.warn(preparing ? new Error(run.error) : error);
    // Bypass a failed archive chain, but never bypass the authoritative fence.
    try {
      const saved = await deps.ownership.save(lease, run, undefined, true);
      if (saved.preparation?.status !== "selecting" || saved.preparation.legacyChecked) await deps.archive(saved);
    } catch (saveError) {
      deps.warn(preparing
        ? new Error("Preparation recovery checkpoint failed [coordinator_checkpoint]. Paid admissions occurred: no.")
        : saveError);
    }
  } finally {
    clearInterval(timer);
    clearInterval(preparationPoll);
    if (polling) await polling;
    unsubscribe();
  }
}
