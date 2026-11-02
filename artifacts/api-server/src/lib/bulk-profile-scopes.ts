import type { BulkBrandRunInput, BulkProfileType } from "@workspace/api-zod";

export const BULK_PROFILE_TYPES = ["brand", "creator", "artist"] as const;
export const MAX_BULK_BATCH = 25;
export const MAX_BULK_CHUNK = 1000;
export const MAX_WORKERS_PER_TYPE = 20;

export function catalogProfileType(type: BulkProfileType) {
  return type === "artist" ? "musician" : type;
}

export function validateBulkSelection(input: Pick<BulkBrandRunInput, "profileIds" | "profileTypes" | "scopes" | "selectionMode" | "paidAcknowledged"> & { continuous?: boolean; profileLimit?: number; workersPerType?: number }): string | undefined {
  if (input.paidAcknowledged !== true) return "Explicitly acknowledge paid provider requests before starting this run.";
  if (input.selectionMode !== undefined && !["remaining", "rerun"].includes(input.selectionMode)) return "Choose remaining profiles or an explicit paid rerun.";
  if (input.continuous && input.selectionMode === "rerun") return "Continuous runs use remaining profiles only. Turn off continuous mode for an explicit paid rerun.";
  if (input.workersPerType !== undefined && (!Number.isSafeInteger(input.workersPerType) || input.workersPerType < 1 || input.workersPerType > MAX_WORKERS_PER_TYPE)) {
    return "Use an integer worker count from 1–20 per profile type.";
  }
  if (input.continuous && !input.scopes) return "Continuous runs require automatic profile-type scopes, not manual selections.";
  if (input.profileLimit !== undefined && (!input.continuous || !Number.isSafeInteger(input.profileLimit) || input.profileLimit < 1 || input.profileLimit > 4294967295)) {
    return "A total profile cap requires continuous mode and a positive integer up to 4294967295.";
  }
  if (input.scopes !== undefined) {
    if (input.profileIds !== undefined || input.profileTypes !== undefined) return "Choose either manual profiles or automatic scopes, not both.";
    if (!input.scopes.length || input.scopes.length > 3) return "Choose one to three profile types.";
    if (new Set(input.scopes.map(scope => scope.profileType)).size !== input.scopes.length) return "Each profile type can be selected only once.";
    if (input.scopes.some(scope => !BULK_PROFILE_TYPES.includes(scope.profileType) || !Number.isSafeInteger(scope.limit) || scope.limit < 1 || scope.limit > MAX_BULK_CHUNK)) {
      return "Use an integer chunk size from 1–1000 for each type.";
    }
    if (input.scopes.reduce((total, scope) => total + scope.limit, 0) > MAX_BULK_CHUNK) return "The combined chunk cannot exceed 1000 profiles across all types.";
    return;
  }
  if (input.selectionMode !== "rerun") return "Manual profile selection requires explicit paid rerun mode; previously investigated profiles may incur charges again.";
  if (!input.profileIds?.length || input.profileIds.length > MAX_BULK_BATCH
    || input.profileIds.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(input.profileIds).size !== input.profileIds.length) return "Select 1–25 distinct valid profile IDs.";
  if (input.profileTypes !== undefined && (input.profileTypes.length !== 1 || !BULK_PROFILE_TYPES.includes(input.profileTypes[0]))) {
    return "Manual selection must use exactly one profile type.";
  }
  return undefined;
}

/** Independent bounded pools per type. Claim each item synchronously before
 * awaiting controls, and drain every in-flight worker after Stop or an error. */
export async function runScopedQueue<T extends { candidate: { profileType?: BulkProfileType }; status: string }>(
  items: T[],
  shouldStop: () => Promise<boolean>,
  process: (item: T) => Promise<void>,
  workersPerType = 1,
) {
  if (!Number.isSafeInteger(workersPerType) || workersPerType < 1 || workersPerType > MAX_WORKERS_PER_TYPE) throw new RangeError("Invalid worker count.");
  let failure: unknown;
  let failed = false;
  const lanes = [...new Set(items.filter(item => item.status !== "completed").map(item => item.candidate.profileType ?? "brand"))];
  await Promise.all(lanes.flatMap(type => {
    const queue = items.filter(item => item.status !== "completed" && (item.candidate.profileType ?? "brand") === type);
    return Array.from({ length: Math.min(workersPerType, queue.length) }, async () => {
    try {
      for (;;) {
        const item = queue.shift();
        if (!item) break;
        if (failed || await shouldStop() || failed) break;
        await process(item);
      }
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    }
    });
  }));
  if (failed) throw failure;
}
