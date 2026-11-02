import { AsyncLocalStorage } from "node:async_hooks";

export type AttemptRow = { profile_id: number; account_ids: string[] };
export type AttemptHistory = { profiles: Set<number>; accounts: Set<string> };
type Selection = { history?: Promise<AttemptHistory> };
const selection = new AsyncLocalStorage<Selection>();

/** Only a single fenced, pre-paid selection may reuse this snapshot. Never
 * cache negative history across runs, resumes, or continuous paid chunks. */
export function withBulkAttemptHistory<T>(work: () => Promise<T>): Promise<T> {
  return selection.run({}, work);
}

export function selectionAttemptHistory(read: () => Promise<AttemptRow[]>): Promise<AttemptHistory> | undefined {
  const scope = selection.getStore();
  if (!scope) return undefined;
  scope.history ??= read().then(rows => ({
    profiles: new Set(rows.map(row => Number(row.profile_id))),
    accounts: new Set(rows.flatMap(row => row.account_ids).filter(Boolean)),
  }));
  return scope.history;
}
