import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  getGetMusicianInstagramResearchCoverageQueryKey,
  useGetMusicianInstagramResearchCoverage,
  type MusicianInstagramResearchTier,
} from '@workspace/api-client-react';

const fmt = (value: number) => value.toLocaleString();
const pct = (value: number, total: number) => total > 0 ? `${(100 * value / total).toFixed(1)}%` : 'N/A';

type CoverageView = 'urls' | 'resolved';

function TierCard({ tier, view }: { tier: MusicianInstagramResearchTier; view: CoverageView }) {
  const urlPct = tier.totalProfiles ? 100 * tier.profilesWithInstagramUrls / tier.totalProfiles : 0;
  const noMatchPct = tier.totalProfiles ? 100 * tier.profilesWithNoSupportedMatch / tier.totalProfiles : 0;
  const covered = view === 'urls'
    ? tier.profilesWithInstagramUrls
    : tier.profilesWithUrlOrNoSupportedMatch;

  return (
    <article className="blk-ig-tier" data-testid={`card-instagram-coverage-tier-${tier.tier}`}>
      <div className="blk-ig-tier-head">
        <h3>Tier {tier.tier}</h3>
        <strong data-testid={`text-instagram-coverage-tier-${tier.tier}-percent`}>{pct(covered, tier.totalProfiles)}</strong>
        <span>{fmt(covered)} of {fmt(tier.totalProfiles)} profiles</span>
      </div>
      <div className="blk-ig-track" role="img" aria-label={`Tier ${tier.tier}: ${fmt(covered)} of ${fmt(tier.totalProfiles)} profiles ${view === 'urls' ? 'have an Instagram URL' : 'have an Instagram URL or no supported match'}`}>
        <span className="blk-ig-segment url" style={{ width: `${urlPct}%` }} />
        {view === 'resolved' && <span className="blk-ig-segment no-candidate" style={{ width: `${noMatchPct}%` }} />}
      </div>
      <dl className="blk-ig-tier-stats">
        <div><dt>Instagram URL</dt><dd data-testid={`text-instagram-coverage-tier-${tier.tier}-urls`}>{fmt(tier.profilesWithInstagramUrls)}</dd></div>
        {view === 'resolved' && (
          <div><dt>No supported match</dt><dd data-testid={`text-instagram-coverage-tier-${tier.tier}-no-match`}>{fmt(tier.profilesWithNoSupportedMatch)}</dd></div>
        )}
      </dl>
    </article>
  );
}

export function MusicianInstagramResearchProgress() {
  const [view, setView] = useState<CoverageView>('urls');
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
          <div className="inv-kicker">Coverage / Instagram · Tiers 1–3</div>
          <h2 id="blk-ig-title">Instagram URL coverage</h2>
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
          {q.isError && <p className="blk-ig-stale" role="status">The latest refresh failed; showing the previous coverage counts.</p>}

          <div className="blk-ig-toggle" role="group" aria-label="Instagram coverage view">
            <button type="button" onClick={() => setView('urls')} aria-pressed={view === 'urls'} data-testid="button-instagram-view-urls">
              Has Instagram URL
            </button>
            <button type="button" onClick={() => setView('resolved')} aria-pressed={view === 'resolved'} data-testid="button-instagram-view-resolved">
              URL or no supported match
            </button>
          </div>
          <p className="blk-ig-view-description">
            {view === 'urls'
              ? 'Profiles with an active catalog Instagram link or a saved Instagram URL.'
              : 'Profiles with an Instagram URL or a completed search that found no supported match.'}
          </p>

          <div className="blk-ig-legend" aria-label="Coverage bar legend">
            <span><i className="url" /> Instagram URL</span>
            {view === 'resolved' && <span><i className="no-candidate" /> No supported match</span>}
          </div>
          <div className="blk-ig-tier-grid">
            {data.tiers.map(tier => <TierCard key={tier.tier} tier={tier} view={view} />)}
          </div>
          <p className="blk-ig-foot" data-testid="text-instagram-research-definition">
            Each profile is counted once using its current-day Tier 1–3 assignment. URL coverage includes active catalog Instagram links and saved non-empty research URLs; saved research URLs are candidates, not approved catalog links. The second view also counts completed searches with no candidate as a practical “no supported match,” not proof that no account exists. Failed and incomplete searches do not count.
          </p>
        </>
      )}
    </section>
  );
}
