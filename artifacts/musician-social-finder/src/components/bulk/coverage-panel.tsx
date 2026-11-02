import { RotateCw } from 'lucide-react';
import { getGetBulkCoverageQueryKey, useGetBulkCoverage, type BulkCoverageBucket } from '@workspace/api-client-react';
import { KIND_META, apiError, type ProfileKind } from '@/lib/bulk';

const GROUPS: { group: BulkCoverageBucket['group']; label: (plural: string) => string }[] = [
  { group: 'tiers_1_3', label: () => 'Tiers 1–3' },
  { group: 'tiers_1_5', label: () => 'Tiers 1–5' },
  { group: 'all', label: p => `All ${p.toLowerCase()}` },
];
const R = 26, C = 2 * Math.PI * R;
const fmt = (n: number) => n.toLocaleString();

function Donut({ label, bucket, id }: { label: string; bucket?: BulkCoverageBucket; id: string }) {
  if (!bucket) {
    return (
      <li className="blk-cov-item" data-testid={`coverage-${id}`}>
        <svg viewBox="0 0 64 64" className="blk-cov-donut" aria-hidden="true"><circle cx="32" cy="32" r={R} className="blk-cov-track" /></svg>
        <div><span className="blk-cov-label">{label}</span><strong className="blk-cov-pct">N/A</strong><em className="inv-mono">No data returned</em></div>
      </li>
    );
  }
  const { total, covered } = bucket;
  const ratio = total > 0 ? Math.min(1, covered / total) : null;
  const pct = ratio === null ? 'N/A' : `${(ratio * 100).toFixed(1)}%`;
  const aria = ratio === null ? `${label}: no profiles, coverage not applicable` : `${label}: ${fmt(covered)} of ${fmt(total)} covered, ${pct}`;
  return (
    <li className="blk-cov-item" data-testid={`coverage-${id}`}>
      <svg viewBox="0 0 64 64" className="blk-cov-donut" role="img" aria-label={aria}>
        <circle cx="32" cy="32" r={R} className="blk-cov-track" />
        {ratio !== null && ratio > 0 && <circle cx="32" cy="32" r={R} className="blk-cov-fill" strokeDasharray={`${C * ratio} ${C}`} transform="rotate(-90 32 32)" />}
      </svg>
      <div>
        <span className="blk-cov-label">{label}</span>
        <strong className="blk-cov-pct" data-testid={`text-coverage-pct-${id}`}>{pct}</strong>
        <em className="inv-mono" data-testid={`text-coverage-count-${id}`}>{total > 0 ? `${fmt(covered)} / ${fmt(total)}` : '0 profiles'}</em>
      </div>
    </li>
  );
}

export function CoveragePanel({ kind }: { kind: ProfileKind }) {
  const m = KIND_META[kind];
  const q = useGetBulkCoverage({ query: { queryKey: getGetBulkCoverageQueryKey(), staleTime: 60000, refetchInterval: 60000 } });
  const type = q.data?.types.find(t => t.profileType === kind);
  const platforms = q.data?.platforms?.length ? q.data.platforms.join(', ') : 'Instagram, TikTok, YouTube';

  return (
    <section className="blk-cov" aria-labelledby="blk-cov-title" data-testid="section-bulk-coverage">
      <div className="blk-cov-head">
        <div><div className="inv-kicker">Coverage / {m.plural.toLowerCase()}</div><h2 id="blk-cov-title">Documented platform resolution</h2></div>
        {q.data && <span className="blk-cov-time inv-mono" data-testid="text-coverage-generated">Server computed {new Date(q.data.generatedAt).toLocaleString()} · may be cached up to 5 min</span>}
      </div>

      {q.isLoading ? (
        <ul className="blk-cov-grid" aria-busy="true" aria-label="Loading coverage">
          {GROUPS.map(g => <li key={g.group} className="blk-cov-item blk-cov-skel"><span className="blk-cov-skel-ring" /><div><i /><i /></div></li>)}
        </ul>
      ) : q.isError ? (
        <div className="blk-cov-error" role="alert" data-testid="status-coverage-error">
          <p>Coverage could not be loaded. {apiError(q.error, '')} Figures are unavailable, not zero.</p>
          <button type="button" className="inv-retry" onClick={() => q.refetch()} disabled={q.isFetching} data-testid="button-retry-coverage"><RotateCw size={12} /> {q.isFetching ? 'Retrying' : 'Retry'}</button>
        </div>
      ) : !type ? (
        <p className="blk-cov-empty" data-testid="status-coverage-empty">No coverage data was returned for {m.plural.toLowerCase()}.</p>
      ) : (
        <ul className="blk-cov-grid">
          {GROUPS.map(g => <Donut key={g.group} id={g.group} label={g.label(m.plural)} bucket={type.buckets.find(b => b.group === g.group)} />)}
        </ul>
      )}

      <p className="blk-cov-foot" data-testid="text-coverage-footnote">
        Counts only active {m.plural.toLowerCase()}; All includes unranked profiles. Covered means saved evidence resolved every supported platform ({platforms}) with a reference account, a verified identity match (likely alone does not count), or an explicit sourced first-party no-account statement. The latest assessment for each platform counts across bulk runs and single investigations linked to one catalog profile by a trusted account URL or confirmed alias, never a display name. Repeated investigations count each profile once. Unlinked or ambiguous single lookups, no result, incomplete and needs-review outcomes are not covered. This is documented platform resolution, not proof that every account on the internet was found.
      </p>
    </section>
  );
}
