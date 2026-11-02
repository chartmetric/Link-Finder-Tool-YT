import { AsyncLocalStorage } from "node:async_hooks";

const guards = new AsyncLocalStorage<() => Promise<void>>();
export function withPaidRequestGuard<T>(guard: () => Promise<void>, work: () => Promise<T>) {
  return guards.run(guard, work);
}
/** Bulk calls are fenced at every network dispatch, including nested/parallel discovery. */
export async function providerFetch(...args: Parameters<typeof fetch>): Promise<Response> {
  await guards.getStore()?.();
  return fetch(...args);
}
