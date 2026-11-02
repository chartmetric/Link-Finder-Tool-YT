import type { BulkBrandItem, BulkBrandRun } from "@workspace/api-zod";
import { BulkOwnership, type Lease } from "./bulk-ownership";
import { withPaidRequestGuard } from "./paid-request-guard";
import { runScopedQueue } from "./bulk-profile-scopes";
import { advanceItemStage, clearItemStage } from "./bulk-item-progress";
import { commitContinuousArchive, continuousArchive, continuousLimitReached, nextContinuousChunk } from "./bulk-continuous";

export type WorkerDependencies = {
  ownership: BulkOwnership;
  processItem: (item: BulkBrandItem, progress: (stage: "searching_platforms" | "verifying_candidates") => void) => Promise<void>;
  archive: (run: BulkBrandRun) => Promise<void>;
  archiveChunk?: (run: BulkBrandRun) => Promise<void>;
  nextChunk?: typeof nextContinuousChunk;
  saveHistory: (item: BulkBrandItem) => Promise<void>;
  warn: (error: unknown) => void;
  prepare?: (run: BulkBrandRun, checkpoint: () => Promise<void>) => Promise<boolean>;
};

/** Only an explicit successful claim launches work; all lanes share its fence. */
export async function executeBulkRun(run: BulkBrandRun, lease: Lease, deps: WorkerDependencies) {
  let heartbeat: Promise<void> | undefined;
  let failure: unknown;
  let writes = Promise.resolve();
  const guard = async () => {
    if (failure) throw failure;
    await deps.ownership.guard(lease);
  };
  const timer = setInterval(() => {
    if (heartbeat || failure) return;
    heartbeat = deps.ownership.renew(lease).then(stop => {
      run.stopRequested ||= stop;
    }).catch(error => { failure = error; }).finally(() => { heartbeat = undefined; });
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
  try {
    if (run.preparation?.status === "selecting") {
      if (!deps.prepare) throw new Error("This worker cannot prepare the run. No paid requests were started.");
      const proceed = await deps.prepare(run, async () => {
        await guard();
        run.stopRequested ||= await deps.ownership.renew(lease);
        if (run.stopRequested) throw new Error("Stopped during profile selection. No paid requests were started.");
        await persist();
      });
      if (!proceed) return; // Legacy request restored and its lease released.
      await guard();
      run.stopRequested ||= await deps.ownership.renew(lease);
      await persist(); // Full ready queue archived before any paid admission.
    }
    for (;;) {
      const indices = new Map(run.items.map((item, index) => [item, index]));
      await runScopedQueue(run.items.filter(item => item.status === "queued"), async () => {
        await guard();
        run.stopRequested ||= await deps.ownership.renew(lease);
        return run.stopRequested;
      }, async item => {
        const index = indices.get(item)!;
        if (!await deps.ownership.admit(lease, index)) { run.stopRequested = true; return; }
        item.status = "running";
        item.startedAt = new Date().toISOString();
        advanceItemStage(item, "reading_reference");
        await persist();
        try {
          await withPaidRequestGuard(guard, () => deps.processItem(item, stage => {
            if (!advanceItemStage(item, stage) || failure) return;
            void persist().catch(error => { failure = error; run.stopRequested = true; });
          }));
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
    run.status = (run.stopRequested && run.preparation?.status === "selecting") || run.items.some(item => item.status === "queued")
      || (run.continuous && (run.stopRequested || (!continuousLimitReached(run.continuous) && !run.continuous.cursors.every(cursor => cursor.exhausted))))
      ? "stopped" : "completed";
    await persist(undefined, true);
  } catch (error) {
    clearInterval(timer);
    if (heartbeat) await heartbeat;
    run.status = "stopped";
    run.error = run.preparation?.status === "selecting"
      ? `Profile preparation stopped: ${error instanceof Error ? error.message : "catalog unavailable"}. No paid provider requests were started. You can explicitly resume this saved run.`
      : error instanceof Error ? error.message : "Bulk queue stopped unexpectedly.";
    deps.warn(error);
    // Bypass a failed archive chain, but never bypass the authoritative fence.
    try {
      const saved = await deps.ownership.save(lease, run, undefined, true);
      if (saved.preparation?.status !== "selecting" || saved.preparation.legacyChecked) await deps.archive(saved);
    } catch (saveError) { deps.warn(saveError); }
  } finally {
    clearInterval(timer);
  }
}
