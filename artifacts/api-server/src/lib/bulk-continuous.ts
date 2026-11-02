import { createHash } from "node:crypto";
import type { BulkBrandCandidate, BulkBrandRun, BulkProfileScopeInput } from "@workspace/api-zod";
import { listEligibleBrands } from "./bulk-brand-candidates";
import { clickHouseJson } from "./clickhouse-profiles";
import { candidateAccountIds, readAttemptedBulkProfileIds } from "./bulk-run-store";
import { withBulkAttemptHistory } from "./bulk-attempt-history";

export type ContinuousProgress = NonNullable<BulkBrandRun["continuous"]>;

export async function initialContinuousProgress(scopes: BulkProfileScopeInput[], profileLimit?: number, readCatalog = clickHouseJson): Promise<ContinuousProgress> {
  const rows = await readCatalog<{ maxId: number }>("SELECT max(id) AS maxId FROM new_vertical.profile FORMAT JSON", {}, 30_000, "catalog_boundary");
  return {
    upperProfileId: Number(rows.data[0]?.maxId ?? 0), batches: 0, completed: 0, failed: 0, completedCostUsd: 0,
    ...(profileLimit !== undefined ? { profileLimit } : {}),
    cursors: scopes.map(scope => ({ profileType: scope.profileType, afterId: 0, exhausted: false, completed: 0, failed: 0 })),
  };
}

/** Bounded discovery of the NEXT chunk. Empty chunks may mean scanning continues,
 * not exhaustion. Persist the returned cursors before paying for any selected profile. */
export async function nextContinuousChunk(
  progress: ContinuousProgress,
  scopes: BulkProfileScopeInput[],
  page = listEligibleBrands,
  attempted = readAttemptedBulkProfileIds,
) {
  return withBulkAttemptHistory(() => selectContinuousChunk(progress, scopes, page, attempted));
}

async function selectContinuousChunk(
  progress: ContinuousProgress,
  scopes: BulkProfileScopeInput[],
  page: typeof listEligibleBrands,
  attempted: typeof readAttemptedBulkProfileIds,
) {
  const cursors = progress.cursors.map(cursor => ({ ...cursor }));
  const selected: BulkBrandCandidate[] = [];
  const remaining = progress.profileLimit === undefined ? Infinity : Math.max(0, progress.profileLimit - progress.completed - progress.failed);
  const seen = new Set<number>();
  const accounts = new Set<string>();
  for (const scope of scopes) {
    if (selected.length >= remaining) break;
    const cursor = cursors.find(row => row.profileType === scope.profileType)!;
    let added = 0;
    for (let scans = 0; !cursor.exhausted && added < scope.limit && scans < 4; scans++) {
      const result = await page({
        profileType: scope.profileType, afterId: cursor.afterId, limit: Math.min(250, Math.max(25, scope.limit - added)), maxProfileId: progress.upperProfileId, remaining: true,
      });
      if (!result.profiles.length) {
        if (result.hasMore) {
          if (result.nextAfterId <= cursor.afterId) throw new Error("Catalog pagination did not advance. The queue stopped without starting another paid lookup.");
          cursor.afterId = result.nextAfterId;
          continue;
        }
        cursor.exhausted = true;
        break;
      }
      const existing = await attempted(result.profiles.map(profile => profile.profileId));
      let consumed = 0;
      for (const profile of result.profiles) {
        if (profile.profileId <= cursor.afterId) throw new Error("Catalog cursor moved backwards; no further paid work was started.");
        cursor.afterId = profile.profileId;
        consumed++;
        const accountIds = candidateAccountIds(profile);
        if (!(profile.canInvestigate ?? Boolean(profile.url)) || existing.has(profile.profileId) || seen.has(profile.profileId) || accountIds.some(id => accounts.has(id))) continue;
        selected.push(profile);
        seen.add(profile.profileId);
        accountIds.forEach(id => accounts.add(id));
        if (++added >= scope.limit || selected.length >= remaining) break;
      }
      if (consumed === result.profiles.length && !result.hasMore) cursor.exhausted = true;
      if (selected.length >= remaining) break;
    }
  }
  return { candidates: selected, cursors };
}

export function continuousLimitReached(progress: ContinuousProgress) {
  return progress.profileLimit !== undefined && progress.completed + progress.failed >= progress.profileLimit;
}

/** A repeat after a crash writes the same archive ID, not a second paid batch. */
export function continuousArchive(run: BulkBrandRun): BulkBrandRun {
  const progress = run.continuous!;
  const hex = createHash("sha256").update(`${run.id}:chunk:${progress.batches + 1}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5"; hex[16] = "a";
  const text = hex.join("");
  const id = `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
  return {
    ...run, id, continuous: undefined, archiveOf: run.id, batchNumber: progress.batches + 1,
    status: "completed", stopRequested: false,
    estimatedCostUsd: run.items.reduce((sum, item) => sum + (item.result?.estimatedCostUsd ?? 0), 0),
  };
}

/** Called only after its archive has persisted. Remove old items before the next
 * checkpoint so snapshots stay bounded and totals never count a chunk twice. */
export function commitContinuousArchive(run: BulkBrandRun) {
  const state = run.continuous!;
  for (const item of run.items) {
    const cursor = state.cursors.find(row => row.profileType === (item.candidate.profileType ?? "brand"))!;
    if (item.status === "completed") { state.completed++; cursor.completed++; }
    if (item.status === "failed") { state.failed++; cursor.failed++; }
    state.completedCostUsd += item.result?.estimatedCostUsd ?? 0;
  }
  state.batches++;
  run.items = [];
  run.estimatedCostUsd = state.completedCostUsd;
}
