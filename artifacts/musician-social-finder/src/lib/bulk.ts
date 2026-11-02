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
  if (run.preparation?.status === 'selecting' && (run.status === 'stopped' || run.status === 'interrupted')) return true;
  if (run.continuous && !run.archiveOf && (run.status === 'stopped' || run.status === 'interrupted')) return true;
  return run.items.some(item => item.status !== 'completed' && !item.retryBlocked);
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

/** Overall processed counts: archived chunks (continuous) plus the current chunk. */
export function overallCounts(run: BulkBrandRun) {
  const c = runCounts(run);
  const a = run.continuous;
  return { ...c, completed: c.completed + (a?.completed ?? 0), failed: c.failed + (a?.failed ?? 0) };
}
export function overallKindCounts(run: BulkBrandRun, kind: ProfileKind) {
  const c = kindCounts(run, kind);
  const cur = run.continuous?.cursors.find(x => kindOf(x) === kind);
  return { ...c, completed: c.completed + (cur?.completed ?? 0), failed: c.failed + (cur?.failed ?? 0), exhausted: cur?.exhausted ?? false };
}
export const MAX_PROFILE_CAP = 4294967295;
/** Parses the optional total cap input. '' -> null (no cap); invalid -> undefined. */
export function parseCap(raw: string): number | null | undefined {
  const t = raw.trim();
  if (!t) return null;
  if (!/^[0-9]+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_PROFILE_CAP ? n : undefined;
}
export function continuousConfirm(cap: number | null) {
  return cap === null ? CONTINUOUS_CONFIRM
    : `Run continuously for up to ${cap} distinct profile${cap === 1 ? '' : 's'} across all chunks and selected types (failed profiles count toward the cap). Each profile calls paid providers and provider cost may vary. Explicitly resuming failed or interrupted profiles can incur additional charges. It keeps running after you close the browser. If the server restarts, the run pauses until someone explicitly resumes it. Start continuous run?`;
}
export const CONTINUOUS_CONFIRM = 'Run continuously processes ALL remaining eligible profiles of the selected types in saved chunks until the catalog is exhausted or you press Stop. There is NO total spending cap: across a large catalog this can mean potentially millions of profiles and paid provider requests. It keeps running after you close the browser. If the server restarts, the run pauses until someone explicitly resumes it. Start continuous run?';
export const RESUME_CONFIRM = 'Resume retries queued, failed and interrupted profiles (not completed ones) and may incur more paid provider requests. Continue?';
export const RESUME_CONTINUOUS_CONFIRM = 'Resume this continuous run? It will keep processing all remaining eligible profiles with no total spending cap until exhausted or stopped, including after the browser closes. Continue?';
export const resumeConfirm = (run: BulkBrandRun) => {
  const cap = run.continuous?.profileLimit;
  if (run.continuous && cap) return `Resume this continuous run? It processes up to ${cap} distinct profiles in total, including after the browser closes. Failed and interrupted profiles in the current chunk may be retried and charged again; this cap is not a limit on provider requests or actual spending. Continue?`;
  return run.continuous ? RESUME_CONTINUOUS_CONFIRM : RESUME_CONFIRM;
};
