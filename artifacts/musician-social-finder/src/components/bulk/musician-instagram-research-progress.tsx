import { RefreshCw } from 'lucide-react';
import {
  getGetMusicianInstagramResearchCoverageQueryKey,
  useGetMusicianInstagramResearchCoverage,
  type MusicianInstagramResearchTier,
} from '@workspace/api-client-react';

const fmt = (value: number) => value.toLocaleString();
const pct = (value: number, total: number) => total > 0 ? `${(100 * value / total).toFixed(1)}%` : 'N/A';

function TierCard({ tier }: { tier: MusicianInstagramResearchTier }) {
  const urlPct = tier.totalProfiles ? 100 * tier.profilesWithInstagramUrls / tier.totalProfiles : 0;
  const noCandidatePct = tier.totalProfiles ? 100 * tier.completedNoCandidateProfiles / tier.totalProfiles : 0;
  const failedPct = tier.totalProfiles ? 100 * tier.failedProfiles / tier.totalProfiles : 0;
  const pendingPct = tier.totalProfiles ? 100 * tier.pendingProfiles / tier.totalProfiles : 0;
  const searchedPct = pct(tier.processedProfiles, tier.totalProfiles);

  return (
    <article className="blk-ig-tier" data-testid={`card-instagram-research-tier-${tier.tier}`}>
      <div className="blk-ig-tier-head">
        <h3>Tier {tier.tier}</h3>
        <strong>{fmt(tier.processedProfiles)} <span>of {fmt(tier.totalProfiles)} profiles searched</span></strong>
        <em>{searchedPct}</em>
      </div>
      <div className="blk-ig-track" role="img" aria-label={`Tier ${tier.tier}: ${fmt(tier.profilesWithInstagramUrls)} with URL candidates, ${fmt(tier.completedNoCandidateProfiles)} completed with no candidate, ${fmt(tier.failedProfiles)} failed, ${fmt(tier.pendingProfiles)} pending, out of ${fmt(tier.totalProfiles)} profiles`}>
        <span className="blk-ig-segment url" style={{ width: `${urlPct}%` }} />
        <span className="blk-ig-segment no-candidate" style={{ width: `${noCandidatePct}%` }} />
        <span className="blk-ig-segment failed" style={{ width: `${failedPct}%` }} />
        <span className="blk-ig-segment pending" style={{ width: `${pendingPct}%` }} />
      </div>
      <dl className="blk-ig-tier-stats">
        <div><dt>URL candidate</dt><dd data-testid={`text-instagram-research-url-${tier.tier}`}>{fmt(tier.profilesWithInstagramUrls)}</dd></div>
        <div><dt>No candidate</dt><dd data-testid={`text-instagram-research-no-match-${tier.tier}`}>{fmt(tier.completedNoCandidateProfiles)}</dd></div>
        <div><dt>Failed</dt><dd data-testid={`text-instagram-research-failed-${tier.tier}`}>{fmt(tier.failedProfiles)}</dd></div>
      </dl>
    </article>
  );
}

export function MusicianInstagramResearchProgress() {
  const q = useGetMusicianInstagramResearchCoverage({
    query: {
      queryKey: getGetMusicianInstagramResearchCoverageQueryKey(),
      refetchOnMount: 'always',
      refetchInterval: 5 * 60_000,
      retry: false,
    },
  });
  const data = q.data;

  return (
    <section className="blk-cov blk-ig" aria-labelledby="blk-ig-title" data-testid="section-instagram-research-progress">
      <div className="blk-cov-head">
        <div>
          <div className="inv-kicker">Saved research / Instagram · Tiers 1–3</div>
          <h2 id="blk-ig-title">Instagram link-search progress</h2>
        </div>
        <div className="blk-ig-head-actions">
          {data && <span className="blk-cov-time inv-mono" data-testid="text-instagram-research-updated">
            Updated {new Date(data.generatedAt).toLocaleString()}
          </span>}
          <button type="button" className="inv-retry" onClick={() => q.refetch()} disabled={q.isFetching} data-testid="button-refresh-instagram-research">
            <RefreshCw size={12} className={q.isFetching ? 'inv-spin' : ''} /> {q.isFetching ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
      </div>

      {q.isLoading && <p className="blk-ig-message" role="status" data-testid="status-instagram-research-loading">Loading saved Instagram research counts…</p>}

      {q.isError && !data && (
        <div className="blk-cov-error" role="alert" data-testid="status-instagram-research-error">
          <p>Instagram research counts could not be loaded. These figures are unavailable, not zero.</p>
          <button type="button" className="inv-retry" onClick={() => q.refetch()} disabled={q.isFetching} data-testid="button-retry-instagram-research">
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {data && (
        <>
          {q.isError && <p className="blk-ig-stale" role="status">The latest refresh failed; showing the previous saved counts.</p>}
          <div className="blk-ig-summary" aria-label="Combined Tier 1–3 Instagram research counts">
            <div><span>Profiles searched</span><strong data-testid="text-instagram-research-processed">{fmt(data.processedProfiles)}</strong><small>{pct(data.processedProfiles, data.totalProfiles)} of {fmt(data.totalProfiles)} tiered profiles</small></div>
            <div><span>Have URL candidates</span><strong data-testid="text-instagram-research-urls">{fmt(data.profilesWithInstagramUrls)}</strong><small>{pct(data.profilesWithInstagramUrls, data.totalProfiles)} of tiered profiles</small></div>
            <div><span>Completed, no candidate</span><strong data-testid="text-instagram-research-no-candidates">{fmt(data.completedNoCandidateProfiles)}</strong><small>Search completed without a URL candidate</small></div>
            <div><span>Failed / pending</span><strong data-testid="text-instagram-research-incomplete">{fmt(data.failedProfiles)} / {fmt(data.pendingProfiles)}</strong><small>Current saved result state</small></div>
          </div>

          <div className="blk-ig-legend" aria-label="Progress bar legend">
            <span><i className="url" /> URL candidate found</span>
            <span><i className="no-candidate" /> Completed, no candidate</span>
            <span><i className="failed" /> Failed</span>
            <span><i className="pending" /> Pending</span>
          </div>
          <div className="blk-ig-tier-grid">
            {data.tiers.map(tier => <TierCard key={tier.tier} tier={tier} />)}
          </div>
          <p className="blk-ig-foot" data-testid="text-instagram-research-definition">
            Counts the latest saved research result per current-day Tier 1–3 profile. Searches targeted profiles without an Instagram catalog link; profiles outside this saved-search cohort are not necessarily waiting to be searched. URL candidates are research results, not approved catalog links. “Completed, no candidate” means the search found no URL candidate, not proof that no account exists.
          </p>
        </>
      )}
    </section>
  );
}
