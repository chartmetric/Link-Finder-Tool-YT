import type { BulkBrandRun, BulkPlatformOutcomeStatus } from '@workspace/api-client-react';

export const ACTIVE_RUN_STATUSES = ['running', 'stopping'] as const;
export const LAST_RUN_KEY = 'bulk-brands:last-run';
export const SELECTION_KEY = 'bulk-brands:selection';

export function isActiveRun(run?: Pick<BulkBrandRun, 'status'>) {
  return !!run && (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status);
}

export function canResume(run?: BulkBrandRun) {
  if (!run || isActiveRun(run)) return false;
  return run.items.some(item => item.status !== 'completed');
}

export function runCounts(run: BulkBrandRun) {
  const c = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const item of run.items) c[item.status]++;
  return c;
}

export const outcomeLabel: Record<BulkPlatformOutcomeStatus, string> = {
  reference: 'Reference account',
  found: 'Found',
  needs_review: 'Needs review',
  not_found: 'No supported account found',
  incomplete: 'Incomplete',
  explicit_unavailable: 'Explicitly unavailable',
};

export function apiError(error: unknown, fallback: string) {
  if (typeof error === 'object' && error !== null) {
    const e = error as { message?: string; data?: { error?: string; message?: string } };
    return e.data?.error || e.data?.message || e.message || fallback;
  }
  return fallback;
}

export function shortUrl(url: string) {
  try {
    const p = new URL(url);
    return `${p.hostname.replace(/^www\./, '')}${p.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
