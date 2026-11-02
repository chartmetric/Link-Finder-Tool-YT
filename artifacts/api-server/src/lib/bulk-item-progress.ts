import type { BulkBrandItem, BulkBrandItemStage } from "@workspace/api-zod";

const stages: BulkBrandItemStage[] = [
  "reading_reference", "searching_platforms", "verifying_candidates",
];

/** At most three transitions per attempt, never one per candidate or provider. */
export function advanceItemStage(item: BulkBrandItem, stage: BulkBrandItemStage) {
  if (item.status !== "running"
    || (item.stage && stages.indexOf(stage) <= stages.indexOf(item.stage))) return false;
  item.stage = stage;
  item.stageStartedAt = new Date().toISOString();
  return true;
}

export function clearItemStage(item: BulkBrandItem) {
  delete item.stage;
  delete item.stageStartedAt;
}
