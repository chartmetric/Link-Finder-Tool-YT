import { RotateCw } from 'lucide-react';
import { useState } from 'react';
import { getBulkCoverage, getGetBulkCoverageQueryKey, useGetBulkCoverage, type BulkCoverageBucket } from '@workspace/api-client-react';
import { KIND_META, apiError, type ProfileKind } from '@/lib/bulk';
import { CoverageBreakdown } from './coverage-breakdown';

const GROUPS: { group: BulkCoverageBucket['group']; label: (plural: string) => string }[] = [
  { group: 'tiers_1_3', label: () => 'Tiers 1–3' },
  { group: 'tiers_1_5', label: () => 'Tiers 1–5' },
  { group: 'all', label: p => `All ${p.toLowerCase()}` },
];
type CoverageMetric = 'all_platforms' | 'active_link' | 'link_candidates_or_resolved';
const R = 26, C = 2 * Math.PI * R;
const fmt = (n: number) => n.toLocaleString();

function Donut({ label, bucket, id, metric }: {
  label: string; bucket?: BulkCoverageBucket; id: string; metric: CoverageMetric;
}) {
  if (!bucket) {
    return (
      <li className="blk-cov-item" data-testid={`coverage-${id}`}>
        <svg viewBox="0 0 64 64" className="blk-cov-donut" aria-hidden="true"><circle cx="32" cy="32" r={R} className="blk-cov-track" /></svg>
        <div><span className="blk-cov-label">{label}</span><strong className="blk-cov-pct">N/A</strong><em className="inv-mono">No data returned</em></div>
      </li>
    );
  }
  const count = metric === 'all_platforms'
    ? bucket.allPlatformsCoveredProfiles
    : metric === 'active_link'
      ? bucket.profilesWithActiveLinks
      : bucket.profilesWithLinksOrFullyResolved;
  const { total } = bucket;
  const { profilesWithLinkCandidates, fullyResolvedProfiles } = bucket;
  const ratio = total > 0 ? Math.min(1, count / total) : null;
  const pct = ratio === null ? 'N/A' : `${(ratio * 100).toFixed(1)}%`;
  const aria = ratio === null
    ? `${label}: no profiles, coverage not applicable`
    : metric === 'all_platforms'
      ? `${label}: ${fmt(count)} of ${fmt(total)} profiles have a supported link, completed no-match, or confirmed absence on every platform, ${pct}`
      : metric === 'active_link'
        ? `${label}: ${fmt(count)} of ${fmt(total)} profiles have at least one active linked account, ${pct}`
        : `${label}: ${fmt(count)} of ${fmt(total)} profiles have a saved link candidate or all platforms fully resolved, ${pct}. ${fmt(profilesWithLinkCandidates)} have link candidates and ${fmt(fullyResolvedProfiles)} are fully resolved.`;
  return (
    <li className="blk-cov-item" data-testid={`coverage-${id}`}>
      <svg viewBox="0 0 64 64" className="blk-cov-donut" role="img" aria-label={aria}>
        <circle cx="32" cy="32" r={R} className="blk-cov-track" />
        {ratio !== null && ratio > 0 && <circle cx="32" cy="32" r={R} className="blk-cov-fill" strokeDasharray={`${C * ratio} ${C}`} transform="rotate(-90 32 32)" />}
      </svg>
      <div>
        <span className="blk-cov-label">{label}</span>
        <strong className="blk-cov-pct" data-testid={`text-coverage-pct-${id}`}>{pct}</strong>
        <em className="inv-mono" data-testid={`text-coverage-count-${id}`}>{total > 0 ? `${fmt(count)} / ${fmt(total)}` : '0 profiles'}</em>
        <small className="blk-cov-components" data-testid={`text-coverage-components-${id}`}>
          {fmt(profilesWithLinkCandidates)} link candidates · {fmt(fullyResolvedProfiles)} fully resolved
        </small>
      </div>
    </li>
  );
}

export function CoveragePanel({ kind }: { kind: ProfileKind }) {
  const [group, setGroup] = useState<BulkCoverageBucket['group']>('tiers_1_3');
  const [metric, setMetric] = useState<CoverageMetric>('all_platforms');
  const m = KIND_META[kind];
  const q = useGetBulkCoverage({ query: {
    queryKey: getGetBulkCoverageQueryKey(), staleTime: 60000, refetchInterval: 60000,
    retry: false,
    queryFn: ({ signal }) => getBulkCoverage({
      signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]),
    }),
  } });
  const type = q.data?.types.find(t => t.profileType === kind);
  const platforms = q.data?.platforms?.length ? q.data.platforms.join(', ') : 'Instagram, TikTok, YouTube';
  const isStale = q.data && Date.now() - Date.parse(q.data.generatedAt) > 5 * 60_000;

  return (
    <section className="blk-cov" aria-labelledby="blk-cov-title" data-testid="section-bulk-coverage">
      <div className="blk-cov-head">
        <div><div className="inv-kicker">Coverage / {m.plural.toLowerCase()}</div><h2 id="blk-cov-title">
          {metric === 'all_platforms'
            ? 'A link, completed no-match, or confirmed absence on every platform'
            : metric === 'active_link'
              ? 'Profiles with at least one active catalog link'
              : 'Profiles with a link candidate or all platforms fully resolved'}
        </h2></div>
        {q.data && <span className="blk-cov-time inv-mono" data-testid="text-coverage-generated">Server computed {new Date(q.data.generatedAt).toLocaleString()} · refreshes every 5 min</span>}
      </div>

      {type && (q.isError || isStale) && <div role="status" data-testid="status-coverage-stale">
        <p>Showing the last successful counts from {new Date(q.data!.generatedAt).toLocaleString()}. {q.isError ? 'The latest refresh failed.' : 'An update is being requested in the background.'}</p>
        <button type="button" className="inv-retry" onClick={() => q.refetch()} disabled={q.isFetching}><RotateCw size={12} /> {q.isFetching ? 'Refreshing' : 'Check for updates'}</button>
      </div>}

      {q.isLoading ? (
        <>
        <p role="status">Calculating coverage across saved investigations. The first load can take up to a minute.</p>
        <ul className="blk-cov-grid" aria-busy="true" aria-label="Loading coverage">
          {GROUPS.map(g => <li key={g.group} className="blk-cov-item blk-cov-skel"><span className="blk-cov-skel-ring" /><div><i /><i /></div></li>)}
        </ul>
        </>
      ) : q.isError && !type ? (
        <div className="blk-cov-error" role="alert" data-testid="status-coverage-error">
          <p>Coverage could not be loaded. {apiError(q.error, '')} Figures are unavailable, not zero.</p>
          <button type="button" className="inv-retry" onClick={() => q.refetch()} disabled={q.isFetching} data-testid="button-retry-coverage"><RotateCw size={12} /> {q.isFetching ? 'Retrying' : 'Retry'}</button>
        </div>
      ) : !type ? (
        <p className="blk-cov-empty" data-testid="status-coverage-empty">No coverage data was returned for {m.plural.toLowerCase()}.</p>
      ) : (
        <>
        <div className="blk-cov-metric-toggle" role="group" aria-label="Coverage measure">
          <button type="button" aria-pressed={metric === 'all_platforms'}
            onClick={() => setMetric('all_platforms')} data-testid="button-coverage-all-platforms">
            All platforms covered
          </button>
          <button type="button" aria-pressed={metric === 'active_link'}
            onClick={() => setMetric('active_link')} data-testid="button-coverage-active-link">
            1+ existing links
          </button>
          <button type="button" aria-pressed={metric === 'link_candidates_or_resolved'}
            onClick={() => setMetric('link_candidates_or_resolved')} data-testid="button-coverage-link-candidates">
            Link candidates or fully resolved
          </button>
        </div>
        <ul className="blk-cov-grid">
          {GROUPS.map(g => <Donut key={g.group} id={g.group} label={g.label(m.plural)} bucket={type.buckets.find(b => b.group === g.group)} metric={metric} />)}
        </ul>
        {metric === 'all_platforms' && <>
          <div className="blk-cov-breakdown-head">
            <h3>What still lacks identity confirmation?</h3>
            <label>Profile group <select value={group} onChange={e => setGroup(e.target.value as BulkCoverageBucket['group'])}>
              {GROUPS.map(g => <option key={g.group} value={g.group}>{g.label(m.plural)}</option>)}
            </select></label>
          </div>
          {type.buckets.find(b => b.group === group) && <CoverageBreakdown key={`${kind}-${group}`} kind={kind} bucket={type.buckets.find(b => b.group === group)!} />}
        </>}
        </>
      )}

      <p className="blk-cov-foot" data-testid="text-coverage-footnote">
        {metric === 'all_platforms'
          ? `Counts each active ${m.plural.toLowerCase()} once only when every supported platform (${platforms}) has a saved profile-link candidate not marked as a mismatch, a completed search with no supported match, or an explicit sourced first-party no-account confirmation. A completed no-match counts as a practical search assessment, not proof that no account exists. Candidate links, including likely or unverified matches, count as link coverage, not identity verification. Provider failures and incomplete searches do not count. All includes unranked profiles. The latest assessment counts across bulk runs and single investigations linked to one catalog profile by a trusted account URL or confirmed alias, never a display name.`
          : metric === 'active_link'
            ? `Counts active ${m.plural.toLowerCase()} with at least one current linked account whose account record is active and has a URL in the catalog. This measures existing catalog links, not links discovered by bulk searches or verified identity matches. The denominator includes all active ${m.plural.toLowerCase()}, including profiles with no linked account. All includes unranked profiles.`
            : `The combined total counts each active ${m.plural.toLowerCase()} once if any supported platform has a saved link candidate or all supported platforms (${platforms}) are fully resolved. Candidate and fully resolved counts can overlap; the combined count never double-counts a profile. Likely and needs-review links are candidates, not verified identities. Full resolution requires a reference account, a verified identity match, or explicit sourced first-party no-account statements for all platforms.`}
      </p>
    </section>
  );
}
