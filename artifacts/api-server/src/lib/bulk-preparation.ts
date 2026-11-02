import type { BulkBrandRun } from "@workspace/api-zod";
import { clickHouseJson } from "./clickhouse-profiles";
import { listEligibleBrands, selectBulkScopes } from "./bulk-brand-candidates";
import { initialContinuousProgress } from "./bulk-continuous";
import { candidateAccountIds, readArchivedBulkRuns } from "./bulk-run-store";
import { bulkOwnership } from "./bulk-ownership-store";
import type { Lease } from "./bulk-ownership";
import { observePreparationRead, PreparationReadError, transientPreparationRead, withPreparationDiagnostics, type PreparationReadCategory } from "./bulk-preparation-diagnostics";
import { abortable } from "./abortable";
import { setTimeout as delay } from "node:timers/promises";
import { withBulkAttemptHistory } from "./bulk-attempt-history";

/** Only read-only catalog requests are retried; never provider calls or writes. */
export function preparationCatalogRead(
  checkpoint: (message: string) => Promise<void>,
  read = clickHouseJson,
  wait = (ms: number) => delay(ms, undefined, { signal }),
  signal?: AbortSignal,
): typeof clickHouseJson {
  return async <T>(sql: string, params: Record<string, string> = {}, _timeout?: number, category: PreparationReadCategory = "candidate_ids") => {
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      const step = category === "prior_attempts_archive" ? "Checking saved attempt history"
        : category === "account_enrichment" ? "Reading linked accounts"
        : category === "catalog_boundary" ? "Reading the catalog boundary"
        : category === "archive_lookup" ? "Checking the saved launch request" : "Reading candidate profiles";
      await checkpoint(attempt === 1
        ? `${step}. No paid lookups have started.`
        : `${step} was slow or unavailable; retrying read ${attempt}/3. No paid lookups have started.`);
      try {
        return await observePreparationRead(category,
          () => abortable(signal, () => read<T>(sql, params, 45_000, category, { signal, maxExecutionSeconds: 40 })),
          result => result.data.length, attempt);
      }
      catch (error) {
        signal?.throwIfAborted(); // User Stop / lost fence is never retryable.
        const retryable = error instanceof PreparationReadError ? error.retryable : transientPreparationRead(error);
        if (!retryable || attempt >= 3) throw error;
        await abortable(signal, () => wait(attempt * 1000));
      }
    }
  };
}

/** Runs inside the fenced worker, never inside the launch HTTP request. */
export async function prepareBulkRun(run: BulkBrandRun, lease: Lease, checkpoint: () => Promise<void>, signal?: AbortSignal) {
  return withPreparationDiagnostics(run, () => withBulkAttemptHistory(() => prepare(run, lease, checkpoint, signal)));
}

async function prepare(run: BulkBrandRun, lease: Lease, checkpoint: () => Promise<void>, signal?: AbortSignal) {
  const preparation = run.preparation!;
  let pagesChecked = 0;
  const report = async (message: string) => {
    signal?.throwIfAborted();
    preparation.message = pagesChecked ? `Checked ${pagesChecked} catalog pages. ${message}` : message;
    await observePreparationRead("coordinator_checkpoint", checkpoint);
  };
  const read = preparationCatalogRead(report, clickHouseJson, undefined, signal);
  await report("Checking the saved request before selecting profiles. No paid lookups have started.");
  if (!preparation.legacyChecked) {
    const legacy = (await abortable(signal, () => readArchivedBulkRuns(run.id, read)))[0];
    signal?.throwIfAborted();
    if (legacy) {
      await observePreparationRead("coordinator_restore", () => bulkOwnership.restoreArchived(lease, legacy));
      return false;
    }
    preparation.legacyChecked = true;
  }
  const page: typeof listEligibleBrands = input => listEligibleBrands(input, read);
  // Re-selecting after an explicit resume is read-only and safe. No item can
  // have been admitted while the authoritative preparation state is selecting.
  run.items = [];
  preparation.selected = 0;
  const scopes = run.scopes!;
  if (preparation.mode !== "manual") {
    const progress = preparation.upperProfileId === undefined
      ? await initialContinuousProgress(scopes, preparation.profileLimit, read)
      : {
        upperProfileId: preparation.upperProfileId, batches: 0, completed: 0, failed: 0, completedCostUsd: 0,
        ...(preparation.profileLimit !== undefined ? { profileLimit: preparation.profileLimit } : {}),
        cursors: scopes.map(scope => ({ profileType: scope.profileType, afterId: 0, exhausted: false, completed: 0, failed: 0 })),
      };
    preparation.upperProfileId = progress.upperProfileId;
    await report("Catalog boundary saved. Selecting eligible profiles.");
    if (preparation.mode === "continuous") run.continuous = progress;
  }
  const candidates = preparation.mode === "continuous" ? []
    : preparation.mode === "manual"
      ? (await page({ limit: 25, profileIds: preparation.profileIds, profileType: scopes[0].profileType, eligibleOnly: true })).profiles
      : await selectBulkScopes(scopes, page, run.selectionMode ?? "remaining", preparation.upperProfileId, async selected => {
        pagesChecked++;
        run.items = selected.map(candidate => ({ candidate, status: "queued", platforms: [] }));
        preparation.selected = selected.length;
        await report(`Selected ${selected.length} of up to ${preparation.requested} eligible profiles. No paid lookups have started.`);
      });
  if (preparation.mode === "manual" && candidates.length !== preparation.profileIds!.length) {
    throw new Error("Some selected profiles are no longer eligible. Refresh the selection and start a new run.");
  }
  const accounts = candidates.flatMap(candidateAccountIds);
  if (new Set(accounts).size !== accounts.length) throw new Error("Selected profiles share an account. Select only one profile per account.");
  if (preparation.mode !== "continuous" && !candidates.length) {
    throw new Error("No eligible unattempted profiles remain. Review saved runs or choose an explicit paid rerun.");
  }
  run.items = candidates.map(candidate => ({ candidate, status: "queued", platforms: [] }));
  preparation.selected = candidates.length;
  preparation.status = "ready";
  preparation.message = preparation.mode === "continuous"
    ? "Catalog ready. Scanning the first chunk."
    : `${candidates.length} eligible profiles selected. Starting the saved queue.`;
  return true;
}
