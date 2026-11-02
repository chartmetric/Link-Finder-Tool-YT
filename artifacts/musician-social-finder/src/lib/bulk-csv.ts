import type { BulkBrandRun, BulkPlatformOutcome, ProfileMatch } from '@workspace/api-client-react';
import { getNetConfidence } from './net-confidence';

export const BULK_CSV_HEADERS = [
  'run_id', 'run_status', 'snapshot_updated_at', 'brand_id', 'brand_name', 'tier', 'item_status',
  'reference_account_id', 'reference_platform', 'reference_handle', 'reference_url', 'reference_confirmed_aliases',
  'target_platform', 'outcome', 'outcome_reason', 'outcome_caution', 'discovered_url', 'confirmed_aliases',
  'net_confidence_evidence_score_0_100', 'net_confidence_status', 'net_confidence_explanation',
  'discovery_score_0_100', 'discovery_methods', 'source_signals', 'candidate_snippet',
  'identity_verification_note', 'outcome_evidence_urls', 'search_sources_json', 'provider_results_json',
  'checked_at', 'searched_at', 'item_error', 'run_error', 'history_save_error',
] as const;

/** Quote every cell, and neutralize spreadsheet formulas before CSV escaping. */
export function escapeCsvCell(value: string | number | null | undefined): string {
  let text = value == null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function caution(outcome?: BulkPlatformOutcome): string {
  if (!outcome) return 'No saved platform assessment.';
  if (outcome.status === 'not_found') return 'No supported account found; not confirmed absence.';
  if (outcome.status === 'incomplete') return 'Incomplete provider results; no conclusion about account absence.';
  if (outcome.status === 'explicit_unavailable' && !outcome.evidenceUrls.length) {
    return 'No source attached; treat this statement as unverified.';
  }
  return '';
}

function row(run: BulkBrandRun, item: BulkBrandRun['items'][number], outcome?: BulkPlatformOutcome, profile?: ProfileMatch) {
  const c = item.candidate;
  const result = item.result;
  const net = profile ? getNetConfidence(profile) : undefined;
  return [
    run.id, run.status, run.updatedAt, c.profileId, c.profileName, c.tier, item.status,
    c.accountId, c.platform, c.handle, c.url, result?.referenceProfile?.urlAliases?.join('\n'),
    outcome?.platform ?? profile?.platform, outcome?.status, outcome?.reason, caution(outcome),
    profile?.url, profile?.urlAliases?.join('\n'), net?.score, net?.status, net?.explanation,
    profile?.confidence, profile?.methods.join('\n'), profile?.signals.join('\n'), profile?.snippet,
    profile?.identityVerificationNote, outcome?.evidenceUrls.join('\n'),
    result ? JSON.stringify(result.sources) : '',
    result ? JSON.stringify(result.methodsUsed) : '',
    outcome?.checkedAt, result?.searchedAt, item.error, run.error, result?.historySaveError,
  ];
}

/**
 * One row per saved platform outcome/candidate, or one blank-candidate row
 * for an outcome with no match. Retain items and candidates without outcomes
 * without inventing assessments. Only reads the supplied saved snapshot.
 */
export function bulkRunToCsv(run: BulkBrandRun): string {
  const rows: ReturnType<typeof row>[] = [];
  for (const item of run.items) {
    const profiles = item.result?.profiles ?? [];
    const covered = new Set<ProfileMatch>();
    for (const outcome of item.platforms) {
      const matches = profiles.filter(p => p.platform.toLowerCase() === outcome.platform.toLowerCase());
      if (!matches.length) rows.push(row(run, item, outcome));
      for (const profile of matches) {
        covered.add(profile);
        rows.push(row(run, item, outcome, profile));
      }
    }
    for (const profile of profiles) {
      if (!covered.has(profile)) rows.push(row(run, item, undefined, profile));
    }
    if (!item.platforms.length && !profiles.length) rows.push(row(run, item));
  }
  return [BULK_CSV_HEADERS, ...rows].map(cells => cells.map(escapeCsvCell).join(',')).join('\r\n') + '\r\n';
}

export function downloadBulkRunCsv(run: BulkBrandRun): void {
  // BOM helps spreadsheet applications preserve Unicode brand names.
  const blob = new Blob(['\uFEFF', bulkRunToCsv(run)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `bulk-brand-run-${run.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`;
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Allow the browser to start the download before releasing the object URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
