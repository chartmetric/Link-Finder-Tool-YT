import type { BulkBrandRun, BulkRunResumeInput } from "@workspace/api-zod";
import { acceptedBulkRequest, withBulkLaunch } from "./bulk-launch-history";
import { clearItemStage } from "./bulk-item-progress";
import { MAX_BULK_CHUNK } from "./bulk-profile-scopes";
import { randomUUID } from "node:crypto";
import { billingProviders, ProviderCreditError, type BillingOutage, type BillingProvider } from "./provider-credit-error";

export const LEASE_MS = 150_000;
export class BulkError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export type Lease = { runId: string; workerId: string; token: number; until: number };
export type RunRecord = {
  run: BulkBrandRun;
  fingerprint: string;
  resumeFrom?: number;
  /** Admitted but unacknowledged jobs are never automatically replayed. */
  uncertain: number[];
};
export type QueueState = { fence: number; owner?: Lease; billing?: Partial<Record<BillingProvider, BillingOutage>> };
export type OwnershipTransactionOptions = {
  /** Shared checks/writes can overlap; queue ownership changes require an exclusive lock. */
  queueLock?: "shared" | "exclusive";
  /** Lock the run row when updating its record under a shared queue lock. */
  recordLock?: "update" | "none";
};
const billingKey = "00000000-0000-4000-8000-000000000000";
function assertBilling(queue: QueueState) {
  const outage = Object.values(queue.billing ?? {}).find(outage => outage && !outage.clearedAt);
  if (outage) throw new BulkError(new ProviderCreditError(outage.provider, outage.httpStatus).message);
}
export type Transaction = { queue: QueueState; record?: RunRecord; now: number; attempts?: number[] };
export interface OwnershipStore {
  transact<T>(id: string, work: (tx: Transaction) => T, options?: OwnershipTransactionOptions): Promise<T>;
  read(id?: string | string[]): Promise<{ queue: QueueState; records: RunRecord[]; now: number }>;
  attempted?(ids: number[]): Promise<number[]>;
}
export function runView(record: RunRecord, queue: QueueState, now: number): BulkBrandRun {
  const run = structuredClone(record.run);
  if (["running", "stopping"].includes(run.status)
    && (!queue.owner || queue.owner.runId !== run.id || queue.owner.token !== run.resumeVersion || queue.owner.until <= now)) {
    run.status = "interrupted";
    run.error = "Worker lease expired. Resume explicitly. An unacknowledged brand may already have incurred charges and will not be retried.";
  }
  return run;
}
export class BulkOwnership {
  private stopListeners = new Map<string, Set<() => void>>();
  onStop(lease: Lease, listener: () => void) {
    const key = `${lease.runId}:${lease.token}`;
    const listeners = this.stopListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.stopListeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.stopListeners.delete(key);
    };
  }
  constructor(private store: OwnershipStore) {}
  async billingHealth() {
    const { queue } = await this.store.read([]);
    return { outages: Object.values(queue.billing ?? {}).filter((outage): outage is BillingOutage => !!outage && !outage.clearedAt) };
  }
  async assertBillingAvailable() {
    const { queue } = await this.store.read([]);
    assertBilling(queue);
  }
  async reportCreditFailure(error: ProviderCreditError) {
    // This is evidence from a dispatched request, not a run mutation. Persist
    // even when its worker has lost ownership; never store the provider body.
    if (!billingProviders.includes(error.provider) || !Number.isInteger(error.httpStatus)) throw new BulkError("Invalid billing evidence.", 400);
    await this.store.transact(billingKey, tx => {
      (tx.queue.billing ??= {})[error.provider] = {
        provider: error.provider, httpStatus: error.httpStatus,
        incidentId: randomUUID(), observedAt: new Date(tx.now).toISOString(),
      };
    });
  }
  async clearBillingOutage(provider: BillingProvider, incidentId: string) {
    await this.store.transact(billingKey, tx => {
      const outage = tx.queue.billing?.[provider];
      if (!outage || outage.incidentId !== incidentId) throw new BulkError("Billing evidence changed. Refresh before clearing the block.");
      if (outage.clearedAt) return; // An identical confirmation is idempotent.
      if (tx.queue.owner && tx.queue.owner.until > tx.now) throw new BulkError("Stop the active queue and wait for it to finish before clearing billing blocks.");
      outage.clearedAt = new Date(tx.now).toISOString();
    });
    return this.billingHealth();
  }
  async importLegacy(run: BulkBrandRun) {
    await this.store.transact(run.id, tx => {
      if (!tx.record) tx.record = {
        run: structuredClone(run), fingerprint: selectionFingerprint(run.items.map(item => item.candidate.profileId)),
        uncertain: run.items.flatMap((item, i) => item.status === "running" ? [i] : []),
      };
      tx.queue.fence = Math.max(tx.queue.fence, run.resumeVersion);
    });
  }
  async read(id?: string | string[]) {
    const { queue, records, now } = await this.store.read(id);
    return records.map(record => runView(record, queue, now));
  }
  async attempted(ids: number[]) { return new Set(await this.store.attempted?.(ids) ?? []); }
  async claim(run: BulkBrandRun, workerId: string, fingerprint: string, expected?: number, launch?: BulkRunResumeInput) {
    return this.store.transact(run.id, tx => {
      const existing = tx.record;
      if (expected === undefined && existing) {
        if (existing.fingerprint !== fingerprint) throw new BulkError("This request ID was already used for a different brand selection.");
        return { run: runView(existing, tx.queue, tx.now), launched: false };
      }
      if (expected !== undefined) {
        if (!existing) throw new BulkError("Bulk run not found.", 404);
        if (launch && acceptedBulkRequest(existing.run, launch.requestId)) return { run: runView(existing, tx.queue, tx.now), launched: false };
        if (existing.run.archiveOf) throw new BulkError("Resume the continuous root run, not an archived chunk.");
        // A retried resume returns the generation it originally created, even after it finishes.
        if (existing.resumeFrom === expected) return { run: runView(existing, tx.queue, tx.now), launched: false };
        if (existing.run.resumeVersion !== expected) throw new BulkError("This run changed. Refresh before resuming.");
        run = launch ? withBulkLaunch(structuredClone(existing.run), "resume", launch.requestId, launch.launchSource) : structuredClone(existing.run);
      }
      assertBilling(tx.queue);
      if (tx.queue.owner && tx.queue.owner.until > tx.now) throw new BulkError("Another bulk queue is active. Stop it or wait before starting another.");
      if (expected !== undefined) {
        // An old worker may still be awaiting the provider. Its admission is durable.
        for (const index of existing!.uncertain) {
          const item = run.items[index];
          if (item.status !== "completed") {
            item.status = "failed";
            item.retryBlocked = true;
            item.error = "Outcome unknown after worker interruption. Not retried to avoid duplicate charges; start a new run only after reviewing provider activity.";
            item.platforms = (["Instagram", "TikTok", "YouTube"] as const).map(platform => ({
              platform, status: "incomplete", checkedAt: new Date(tx.now).toISOString(), evidenceUrls: [],
              reason: item.error!,
            }));
          }
        }
        const retry = run.items.filter((item, i) => item.status !== "completed" && !existing!.uncertain.includes(i));
        if (!retry.length && !run.continuous && run.preparation?.status !== "selecting") {
          if (!existing!.uncertain.length) throw new BulkError("All brands in this run are already completed.");
          run.status = "stopped";
          run.error = "No safely retryable brands remain. Completed results are saved; uncertain paid work cannot be replayed.";
          tx.record!.run = run;
          tx.record!.resumeFrom = expected;
          return { run: structuredClone(run), launched: false };
        }
        for (const item of retry) {
          item.status = "queued";
          clearItemStage(item);
          delete item.error;
          delete item.startedAt;
          delete item.completedAt;
          delete item.result;
          item.platforms = [];
        }
      }
      const maximum = run.scopes ? MAX_BULK_CHUNK : 25;
      if ((!run.continuous && run.preparation?.status !== "selecting" && run.items.length < 1) || run.items.length > maximum) throw new BulkError(`Select 1–${maximum} profiles.`, 400);
      // Global, durable monotonic fencing number; never use worker clocks for ordering.
      const token = ++tx.queue.fence;
      if (!Number.isSafeInteger(token)) throw new BulkError("Bulk fencing sequence exhausted.", 503);
      const lease: Lease = { runId: run.id, workerId, token, until: tx.now + LEASE_MS };
      tx.queue.owner = lease;
      run.status = "running";
      run.workerId = workerId;
      run.resumeVersion = token;
      run.stopRequested = false;
      run.updatedAt = run.heartbeatAt = new Date(tx.now).toISOString();
      delete run.error;
      tx.record = { run, fingerprint: existing?.fingerprint ?? fingerprint, resumeFrom: expected, uncertain: existing?.uncertain ?? [] };
      return { run: structuredClone(run), lease: { ...lease }, launched: true };
    });
  }
  private owned(tx: Transaction, lease: Lease) {
    const owner = tx.queue.owner;
    if (!owner || owner.runId !== lease.runId || owner.workerId !== lease.workerId
      || owner.token !== lease.token || owner.until <= tx.now
      || tx.record?.run.resumeVersion !== lease.token) {
      throw new BulkError("Worker lease lost. No further paid requests or result writes are permitted.");
    }
    return tx.record!;
  }
  async renew(lease: Lease) {
    return this.store.transact(lease.runId, tx => {
      const record = this.owned(tx, lease);
      tx.queue.owner!.until = tx.now + LEASE_MS;
      record.run.heartbeatAt = new Date(tx.now).toISOString();
      return record.run.stopRequested;
    });
  }
  async guard(lease: Lease) {
    await this.store.transact(lease.runId, tx => { this.owned(tx, lease); }, { queueLock: "shared" });
  }
  /** Restore an old request without ever replaying its paid admissions. */
  async restoreArchived(lease: Lease, archived: BulkBrandRun) {
    return this.store.transact(lease.runId, tx => {
      const record = this.owned(tx, lease);
      const run = structuredClone(archived);
      run.resumeVersion = lease.token;
      run.workerId = lease.workerId;
      run.updatedAt = run.heartbeatAt = new Date(tx.now).toISOString();
      if (["running", "stopping", "interrupted"].includes(run.status)) {
        run.status = "stopped";
        run.error = "Archived run restored. Resume explicitly; uncertain paid work will not be repeated.";
      }
      record.run = run;
      record.uncertain = run.items.flatMap((item, i) => item.status === "running" || item.retryBlocked ? [i] : []);
      delete tx.queue.owner;
      return structuredClone(run);
    });
  }
  async admit(lease: Lease, index: number) {
    return this.store.transact(lease.runId, tx => {
      const record = this.owned(tx, lease);
      if (record.run.stopRequested) return false;
      assertBilling(tx.queue);
      if (record.run.preparation?.status === "selecting") throw new BulkError("Profile selection is not complete. Paid work is blocked.");
      const item = record.run.items[index];
      if (!item || item.status !== "queued" || record.uncertain.includes(index)) throw new BulkError("Brand already admitted; refusing duplicate paid work.");
      record.uncertain.push(index);
      (tx.attempts ??= []).push(item.candidate.profileId);
      item.status = "running";
      item.startedAt = new Date(tx.now).toISOString();
      return true;
    }, { queueLock: "shared", recordLock: "update" });
  }
  /** Only after the deterministic archive is durable may indices be reused. */
  async clearChunk(lease: Lease, run: BulkBrandRun) {
    return this.store.transact(lease.runId, tx => {
      const record = this.owned(tx, lease);
      if (record.run.items.some(item => item.status === "queued" || item.status === "running")) {
        throw new BulkError("Cannot archive unfinished work.");
      }
      const saved = structuredClone(run);
      saved.stopRequested ||= record.run.stopRequested;
      saved.updatedAt = new Date(tx.now).toISOString();
      record.run = saved;
      record.uncertain = [];
      return structuredClone(saved);
    }, { queueLock: "shared", recordLock: "update" });
  }
  async save(lease: Lease, run: BulkBrandRun, acknowledgedIndex?: number, release = false) {
    return this.store.transact(lease.runId, tx => {
      const record = this.owned(tx, lease);
      const saved = structuredClone(run);
      saved.stopRequested ||= record.run.stopRequested;
      saved.updatedAt = new Date(tx.now).toISOString();
      saved.heartbeatAt = record.run.heartbeatAt;
      record.run = saved;
      if (acknowledgedIndex !== undefined) record.uncertain = record.uncertain.filter(i => i !== acknowledgedIndex);
      if (release) delete tx.queue.owner;
      return structuredClone(saved);
    }, { queueLock: release ? "exclusive" : "shared", recordLock: "update" });
  }
  async stop(id: string, expected: number) {
    const run = await this.store.transact(id, tx => {
      if (!tx.record) throw new BulkError("Bulk run not found.", 404);
      if (tx.record.run.resumeVersion !== expected) throw new BulkError("This run changed. Refresh before stopping.");
      if (["running", "stopping"].includes(tx.record.run.status)) {
        tx.record.run.stopRequested = true;
        tx.record.run.status = "stopping";
      }
      return runView(tx.record, tx.queue, tx.now);
    }, { queueLock: "shared", recordLock: "update" });
    // Notify only after the durable, generation-checked transaction commits.
    if (run.stopRequested) for (const notify of this.stopListeners.get(`${id}:${expected}`) ?? []) notify();
    return run;
  }
}
export function selectionFingerprint(ids: number[]) {
  return [...ids].sort((a, b) => a - b).join(",");
}
