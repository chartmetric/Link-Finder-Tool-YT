import { AsyncLocalStorage } from "node:async_hooks";
import type { BulkBrandRun } from "@workspace/api-zod";
import { logger } from "./logger";

export type PreparationReadCategory = "catalog_boundary" | "candidate_ids" | "account_enrichment"
  | "prior_attempts_archive" | "prior_attempts_coordinator" | "archive_lookup"
  | "coordinator_checkpoint" | "coordinator_restore";
type Timing = {
  event: "bulk_preparation_read"; phase: "started" | "succeeded" | "failed";
  runId: string; requestId: string; generation: number; category: PreparationReadCategory;
  attempt: number; durationMs: number; rowCount: number | null; paidAdmissionsOccurred: false;
  failureKind?: "timeout" | "transient" | "unavailable";
};
type Context = {
  runId: string; requestId: string; generation: number;
  emit: (timing: Timing) => void; now: () => number;
};
const context = new AsyncLocalStorage<Context>();

export function transientPreparationRead(error: unknown) {
  return error instanceof Error && (
    ["TimeoutError", "AbortError"].includes(error.name)
    || /fetch failed|ECONNRESET|CLICKHOUSE_QUERY_FAILED:(429|5\d\d):/.test(error.message));
}

/** No cause/raw error: database errors can contain SQL, credentials or URLs. */
export class PreparationReadError extends Error {
  constructor(public category: PreparationReadCategory, public retryable: boolean) {
    super(`Preparation read failed [${category}]. Paid admissions occurred: no.`);
    this.name = "PreparationReadError";
  }
}

export function withPreparationDiagnostics<T>(
  run: BulkBrandRun, work: () => Promise<T>,
  emit: Context["emit"] = timing => logger.info(timing, "Bulk preparation read"),
  now = () => performance.now(),
) {
  return context.run({
    runId: run.id, requestId: run.launchHistory?.at(-1)?.requestId ?? run.id,
    generation: run.resumeVersion, emit, now,
  }, work);
}

/** Inactive outside the fenced pre-paid phase; never logs arguments or results. */
export async function observePreparationRead<T>(
  category: PreparationReadCategory, work: () => Promise<T>,
  rows: (result: T) => number | null = () => null, attempt = 1,
): Promise<T> {
  const scope = context.getStore();
  if (!scope) return work();
  const started = scope.now();
  const emit = (phase: Timing["phase"], rowCount: number | null, failureKind?: Timing["failureKind"]) => scope.emit({
    event: "bulk_preparation_read", phase, runId: scope.runId, requestId: scope.requestId,
    generation: scope.generation, category, attempt,
    durationMs: Math.max(0, scope.now() - started), rowCount, paidAdmissionsOccurred: false,
    ...(failureKind ? { failureKind } : {}),
  });
  emit("started", null);
  try {
    const result = await work();
    emit("succeeded", rows(result));
    return result;
  } catch (error) {
    const retryable = transientPreparationRead(error);
    emit("failed", null, error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
      ? "timeout" : retryable ? "transient" : "unavailable");
    throw new PreparationReadError(category, retryable);
  }
}
