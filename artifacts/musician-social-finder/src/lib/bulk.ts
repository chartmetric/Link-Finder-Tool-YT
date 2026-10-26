import type { BulkBrandCandidate, BulkBrandRun, BulkPlatformOutcomeStatus } from '@workspace/api-client-react';

export function canInvestigate(profile: BulkBrandCandidate) {
  return profile.canInvestigate ?? Boolean(profile.url);
}

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

export type ProfileKind = 'brand' | 'creator' | 'artist';
export const PROFILE_KINDS: ProfileKind[] = ['brand', 'creator', 'artist'];
export const KIND_META: Record<ProfileKind, { label: string; plural: string; path: string; code: string }> = {
  brand: { label: 'Brand', plural: 'Brands', path: '/bulk/brands', code: 'BR' },
  creator: { label: 'Creator', plural: 'Creators', path: '/bulk/creators', code: 'CR' },
  artist: { label: 'Artist', plural: 'Artists', path: '/bulk/artists', code: 'AR' },
};
/** Legacy candidates/runs without a type are brands. */
export function kindOf(c?: { profileType?: string } | null): ProfileKind {
  const t = c?.profileType;
  return t === 'creator' || t === 'artist' ? t : 'brand';
}
export function selectionKey(kind: ProfileKind) {
  return kind === 'brand' ? SELECTION_KEY : `bulk-profiles:selection:${kind}`;
}
export const WIDGET_KEY = 'bulk-profiles:widget';
export function runKinds(run: BulkBrandRun): ProfileKind[] {
  const s = new Set<ProfileKind>();
  for (const sc of run.scopes ?? []) s.add(kindOf(sc));
  for (const i of run.items) s.add(kindOf(i.candidate));
  if (s.size === 0) s.add('brand');
  return PROFILE_KINDS.filter(k => s.has(k));
}
export function kindCounts(run: BulkBrandRun, kind: ProfileKind) {
  const c = { queued: 0, running: 0, completed: 0, failed: 0, total: 0 };
  for (const item of run.items) if (kindOf(item.candidate) === kind) { c[item.status]++; c.total++; }
  return c;
}
