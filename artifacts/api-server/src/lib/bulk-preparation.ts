import type { BulkBrandRun } from "@workspace/api-zod";
import { clickHouseJson } from "./clickhouse-profiles";
import { listEligibleBrands, selectBulkScopes } from "./bulk-brand-candidates";
import { initialContinuousProgress } from "./bulk-continuous";
import { candidateAccountIds, readArchivedBulkRuns } from "./bulk-run-store";
import { bulkOwnership } from "./bulk-ownership-store";
import type { Lease } from "./bulk-ownership";

/** Only read-only catalog requests are retried; never provider calls or writes. */
export function preparationCatalogRead(
  checkpoint: (message: string) => Promise<void>,
  read = clickHouseJson,
  wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
): typeof clickHouseJson {
  return async <T>(sql: string, params: Record<string, string> = {}) => {
    for (let attempt = 1; ; attempt++) {
      await checkpoint(attempt === 1
        ? "Reading the catalog. No paid lookups have started."
        : `Catalog read was slow or unavailable; retrying read ${attempt}/3. No paid lookups have started.`);
      try { return await read<T>(sql, params, 45_000); }
      catch (error) {
        const message = error instanceof Error ? error.message : "";
        const retryable = error instanceof Error && (
          ["TimeoutError", "AbortError"].includes(error.name) ||
          /fetch failed|ECONNRESET|CLICKHOUSE_QUERY_FAILED:(429|5\d\d):/.test(message));
        if (!retryable || attempt >= 3) throw error;
        await wait(attempt * 1000);
      }
    }
  };
}

/** Runs inside the fenced worker, never inside the launch HTTP request. */
export async function prepareBulkRun(run: BulkBrandRun, lease: Lease, checkpoint: () => Promise<void>) {
  const preparation = run.preparation!;
  const report = async (message: string) => {
    preparation.message = message;
    await checkpoint();
  };
  await report("Checking the saved request before selecting profiles. No paid lookups have started.");
  if (!preparation.legacyChecked) {
    const legacy = (await readArchivedBulkRuns(run.id))[0];
    if (legacy) {
      await bulkOwnership.restoreArchived(lease, legacy);
      return false;
    }
    preparation.legacyChecked = true;
  }
  const read = preparationCatalogRead(report);
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
