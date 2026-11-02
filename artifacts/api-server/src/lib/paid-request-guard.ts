import { AsyncLocalStorage } from "node:async_hooks";
import { providerCreditError, type ProviderCreditError } from "./provider-credit-error";

type Guard = { guard: () => Promise<void>; onCreditFailure?: (error: ProviderCreditError) => Promise<void> };
const guards = new AsyncLocalStorage<Guard>();
export function withPaidRequestGuard<T>(guard: () => Promise<void>, work: () => Promise<T>, onCreditFailure?: Guard["onCreditFailure"]) {
  return guards.run({ guard, onCreditFailure }, work);
}
/** Bulk calls are fenced at every network dispatch, including nested/parallel discovery. */
export async function providerFetch(...args: Parameters<typeof fetch>): Promise<Response> {
  const scope = guards.getStore();
  await scope?.guard();
  const response = await fetch(...args);
  if (scope?.onCreditFailure) {
    const error = await providerCreditError(args[0], response);
    if (error) {
      await scope.onCreditFailure(error);
      void response.body?.cancel().catch(() => {});
      throw error;
    }
  }
  return response;
}
