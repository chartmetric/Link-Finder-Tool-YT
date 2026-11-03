import type { BulkBrandRun } from '@workspace/api-client-react';
import { continuous, run } from './progress-fixtures';

// The public, sanitized error contract from ProviderCreditError. Deliberately
// independent of the backend implementation: a UI test must not import workers
// or initialize provider clients. No raw provider response belongs in this API.
export const CREDIT_REASON = 'Automatic stop: OpenRouter reported exhausted credits or a billing limit (HTTP 402). '
  + 'No further paid requests will be started for this run. Replenish provider credits, then resume explicitly. '
  + 'Requests already dispatched may still incur charges.';

export function creditRun(multiTypeContinuous = false): BulkBrandRun {
  const initial = multiTypeContinuous ? continuous(30) : run();
  if (!multiTypeContinuous) return initial;
  return {
    ...initial,
    scopes: [{ profileType: 'brand', limit: 2 }, { profileType: 'creator', limit: 2 }],
    items: initial.items.map((item, n) => ({
      ...item,
      candidate: { ...item.candidate, profileType: n % 2 ? 'creator' : 'brand' },
    })),
    continuous: {
      ...initial.continuous!,
      cursors: [
        { profileType: 'brand', afterId: 10, exhausted: false, completed: 4, failed: 1 },
        { profileType: 'creator', afterId: 20, exhausted: false, completed: 4, failed: 1 },
      ],
    },
  };
}

export function draining(previous: BulkBrandRun): BulkBrandRun {
  return {
    ...previous, status: 'stopping', stopRequested: true, error: CREDIT_REASON,
    updatedAt: '2026-10-27T12:00:03.000Z',
    items: previous.items.map((item, n) => n === 0
      ? { ...item, status: 'failed', error: CREDIT_REASON } : item),
  };
}

export function stopped(previous: BulkBrandRun): BulkBrandRun {
  return {
    ...previous, status: 'stopped', updatedAt: '2026-10-27T12:00:06.000Z',
    // An already-dispatched lookup drains; untouched queued work stays queued.
    items: previous.items.map(item => item.status === 'running'
      ? { ...item, status: 'completed' } : item),
  };
}
