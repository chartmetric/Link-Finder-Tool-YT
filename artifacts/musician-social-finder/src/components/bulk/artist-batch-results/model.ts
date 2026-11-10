import type { ArtistResultRow, ArtistResultField, ArtistResultFieldGroup } from '@workspace/api-client-react';

export const PAGE_SIZE = 25;
export const GROUPS: { key: ArtistResultFieldGroup; label: string; note: string }[] = [
  { key: 'identity', label: 'Identity', note: 'Who the row refers to and which account URLs were involved.' },
  { key: 'decision', label: 'Decision', note: 'Outcome, uncalibrated model identity scores and thresholds. Not accepted is not proof of a wrong account or an absent link.' },
  { key: 'metadata', label: 'Metadata', note: 'Profile metadata. Labels show whether it was actually sent to the model or merely available.' },
  { key: 'provenance', label: 'Provenance', note: 'Where, when and how this row was produced. Captures may be stale.' },
  { key: 'raw', label: 'Raw', note: 'Every remaining original CSV column, verbatim.' },
];
export type ResultFilter = 'all' | 'verified' | 'review' | 'not_inspected' | 'metadata_failed' | 'no_candidate' | 'controls'
  | 'research_supported' | 'held' | 'skipped' | 'partial_failure' | 'shared_handle';
export const FILTERS: { key: ResultFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'verified', label: 'Verified' }, { key: 'review', label: 'Review' },
  { key: 'not_inspected', label: 'Not inspected' }, { key: 'metadata_failed', label: 'Metadata unavailable' },
  { key: 'no_candidate', label: 'No candidate' }, { key: 'controls', label: 'Controls' },
  { key: 'research_supported', label: 'Research supported' }, { key: 'held', label: 'Held without call' },
  { key: 'skipped', label: 'Skipped / incomplete' }, { key: 'partial_failure', label: 'Partial failures' },
  { key: 'shared_handle', label: 'Shared-handle holds' },
];

export type Tag = { text: string; tone: 'sent' | 'avail' | 'stale' | 'old' | 'new' | 'control' };
export function fieldTags(f: ArtistResultField): Tag[] {
  const l = f.label.toLowerCase(); const t: Tag[] = [];
  if (/actually sent|actuallysupplied|metadataactuallyused/.test(l)) t.push({ text: 'Actually sent', tone: 'sent' });
  else if (/avail|available/.test(l)) t.push({ text: 'Available, not necessarily sent', tone: 'avail' });
  if (l.includes('score') && /\bold\b|old_|previous|prior|original/.test(l)) t.push({ text: 'Old score', tone: 'old' });
  else if (l.includes('score') && /\bnew\b|new_|current_score|rescore/.test(l)) t.push({ text: 'New score', tone: 'new' });
  if (l === 'comparison type' && f.value.toLowerCase() === 'control') t.push({ text: 'Control comparison', tone: 'control' });
  return t;
}

export function tryJson(v: string): unknown | undefined {
  const s = v.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

export const isUrl = (v: string | null | undefined) => !!v && /^https?:\/\//i.test(v.trim());
export const fmtScore = (n: number | null) => n === null ? 'No score' : n.toFixed(n <= 1 ? 3 : 1);
export const usd = (n: number | null) => n === null ? 'Not recorded' : `$${n.toFixed(n > 0 && n < 0.01 ? 6 : 2)}`;
export const statusTone = (s: string) => {
  const l = s.toLowerCase();
  if (l.includes('verif')) return 'ok'; if (l.includes('fail')) return 'bad';
  if (l.includes('review')) return 'warn'; if (l.includes('no_candidate') || l.includes('no candidate')) return 'muted';
  return 'neutral';
};
export type Row = ArtistResultRow;
