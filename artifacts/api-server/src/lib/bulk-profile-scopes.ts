import type { BulkBrandRunInput, BulkProfileType } from "@workspace/api-zod";

export const BULK_PROFILE_TYPES = ["brand", "creator", "artist"] as const;
export const MAX_BULK_BATCH = 25;

export function catalogProfileType(type: BulkProfileType) {
  return type === "artist" ? "musician" : type;
}

export function validateBulkSelection(input: Pick<BulkBrandRunInput, "profileIds" | "profileTypes" | "scopes"> & { continuous?: boolean; profileLimit?: number }): string | undefined {
  if (input.continuous && !input.scopes) return "Continuous runs require automatic profile-type scopes, not manual selections.";
  if (input.profileLimit !== undefined && (!input.continuous || !Number.isSafeInteger(input.profileLimit) || input.profileLimit < 1 || input.profileLimit > 4294967295)) {
    return "A total profile cap requires continuous mode and a positive integer up to 4294967295.";
  }
  if (input.scopes !== undefined) {
    if (input.profileIds !== undefined || input.profileTypes !== undefined) return "Choose either manual profiles or automatic scopes, not both.";
    if (!input.scopes.length || input.scopes.length > 3) return "Choose one to three profile types.";
    if (new Set(input.scopes.map(scope => scope.profileType)).size !== input.scopes.length) return "Each profile type can be selected only once.";
    if (input.scopes.some(scope => !BULK_PROFILE_TYPES.includes(scope.profileType) || !Number.isSafeInteger(scope.limit) || scope.limit < 1 || scope.limit > MAX_BULK_BATCH)) {
      return "Use an integer profile limit from 1–25 for each type.";
    }
    if (input.scopes.reduce((total, scope) => total + scope.limit, 0) > MAX_BULK_BATCH) return "The combined batch cannot exceed 25 profiles across all types.";
    return;
  }
  if (!input.profileIds?.length || input.profileIds.length > MAX_BULK_BATCH
    || input.profileIds.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(input.profileIds).size !== input.profileIds.length) return "Select 1–25 distinct valid profile IDs.";
  if (input.profileTypes !== undefined && (input.profileTypes.length !== 1 || !BULK_PROFILE_TYPES.includes(input.profileTypes[0]))) {
    return "Manual selection must use exactly one profile type.";
  }
  return undefined;
}

/** One sequential lane per type; lanes run concurrently. Wait for every
 * in-flight lane even after an error so nothing continues paying after return. */
export async function runScopedQueue<T extends { candidate: { profileType?: BulkProfileType }; status: string }>(
  items: T[],
  shouldStop: () => Promise<boolean>,
  process: (item: T) => Promise<void>,
) {
  let failure: unknown;
  let failed = false;
  const lanes = [...new Set(items.filter(item => item.status !== "completed").map(item => item.candidate.profileType ?? "brand"))];
  await Promise.all(lanes.map(async type => {
    try {
      for (const item of items) {
        if (item.status === "completed" || (item.candidate.profileType ?? "brand") !== type) continue;
        if (failed || await shouldStop() || failed) break;
        await process(item);
      }
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    }
  }));
  if (failed) throw failure;
}
