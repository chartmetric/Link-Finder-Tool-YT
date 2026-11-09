import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  getGetMusicianInstagramResearchCoverageQueryKey,
  useGetMusicianInstagramResearchCoverage,
  type MusicianInstagramResearchTier,
  type MusicianInstagramResearchHistoryDay,
} from '@workspace/api-client-react';

const fmt = (value: number) => value.toLocaleString();
const pct = (value: number, total: number) => total > 0 ? `${(100 * value / total).toFixed(1)}%` : 'N/A';
const fmtHistoryDate = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString();

function HistoryTable({ history }: { history: MusicianInstagramResearchHistoryDay[] }) {
  return (
    <section className="blk-ig-history" aria-labelledby="blk-ig-history-title" data-testid="section-instagram-research-history">
      <div className="blk-ig-history-head">
        <h3 id="blk-ig-history-title">Search history · Tiers 1–3</h3>
        <span>Most recent 90 days with saved attempts</span>
      </div>
      <p className="blk-ig-history-note">
        Profiles are counted once per day and once cumulatively. Attempts are counted per run and profile, so retries remain visible. Outcome profile counts can overlap when a profile has different results across retries.
      </p>
      {history.length === 0 ? (
        <p className="blk-ig-message" data-testid="text-instagram-research-history-empty">No dispatched search attempts are saved for this Tier 1–3 cohort yet.</p>
      ) : (
        <div className="blk-ig-history-scroll">
          <table className="blk-ig-history-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Unique profiles</th>
                <th scope="col">Cumulative unique</th>
                <th scope="col">Attempts</th>
                <th scope="col">Candidates<br /><small>profiles / attempts</small></th>
                <th scope="col">Candidate URLs</th>
                <th scope="col">No candidate<br /><small>profiles / attempts</small></th>
                <th scope="col">Failed<br /><small>profiles / attempts</small></th>
                <th scope="col">In progress<br /><small>attempts</small></th>
              </tr>
            </thead>
            <tbody>
              {history.map(day => (
                <tr key={day.date} data-testid={`row-instagram-research-history-${day.date}`}>
                  <th scope="row">{fmtHistoryDate(day.date)}</th>
                  <td>{fmt(day.uniqueProfiles)}</td>
                  <td>{fmt(day.cumulativeUniqueProfiles)}</td>
                  <td>{fmt(day.attempts)}</td>
                  <td>{fmt(day.candidateProfiles)} / {fmt(day.candidateAttempts)}</td>
                  <td>{fmt(day.candidateUrls)}</td>
                  <td>{fmt(day.noCandidateProfiles)} / {fmt(day.noCandidateAttempts)}</td>
                  <td>{fmt(day.failedProfiles)} / {fmt(day.failedAttempts)}</td>
                  <td>{fmt(day.inProgressAttempts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

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
        <div><dt>Catalog links</dt><dd data-testid={`text-instagram-coverage-tier-${tier.tier}-catalog`}>{fmt(tier.profilesWithCatalogInstagramUrls)}</dd></div>
        <div><dt>Research candidates</dt><dd data-testid={`text-instagram-coverage-tier-${tier.tier}-candidates`}>{fmt(tier.profilesWithResearchCandidates)}</dd></div>
        <div><dt>No supported match</dt><dd data-testid={`text-instagram-coverage-tier-${tier.tier}-no-match`}>{fmt(tier.profilesWithNoSupportedMatch)}</dd></div>
        <div><dt>Failed searches</dt><dd>{fmt(tier.failedProfiles)}</dd></div>
        <div><dt>Pending searches</dt><dd>{fmt(tier.pendingProfiles)}</dd></div>
        <div><dt>Unresolved / not searched</dt><dd data-testid={`text-instagram-coverage-tier-${tier.tier}-incomplete`}>{fmt(tier.profilesWithFailedOrIncompleteSearches)}</dd></div>
      </dl>
    </article>
  );
}

function LatestResearchSummary({ tiers }: { tiers: MusicianInstagramResearchTier[] }) {
  const tier1to3 = tiers.filter(tier => tier.tier <= 3);
  const sum = (key: keyof Omit<MusicianInstagramResearchTier, 'tier'>) =>
    tier1to3.reduce((total, tier) => total + tier[key], 0);
  const totalProfiles = sum('totalProfiles');
  const processedProfiles = sum('processedProfiles');
  const profilesWithResearchUrls = sum('profilesWithResearchUrls');
  const completedNoCandidateProfiles = sum('completedNoCandidateProfiles');
  const failedProfiles = sum('failedProfiles');
  const pendingProfiles = sum('pendingProfiles');

  return (
    <section className="blk-ig-latest" aria-labelledby="blk-ig-latest-title" data-testid="section-instagram-research-latest-state">
      <h3 id="blk-ig-latest-title">Latest saved search state · Tiers 1–3</h3>
      <div className="blk-ig-summary" aria-label="Latest Tier 1–3 Instagram research results">
        <div><span>Profiles searched</span><strong data-testid="text-instagram-research-processed">{fmt(processedProfiles)}</strong><small>{pct(processedProfiles, totalProfiles)} of {fmt(totalProfiles)} current profiles</small></div>
        <div><span>Have URL candidates</span><strong data-testid="text-instagram-research-urls">{fmt(profilesWithResearchUrls)}</strong><small>Latest result contains candidate URLs</small></div>
        <div><span>Completed, no candidate</span><strong data-testid="text-instagram-research-no-candidates">{fmt(completedNoCandidateProfiles)}</strong><small>Latest search completed without a candidate</small></div>
        <div><span>Failed / pending</span><strong data-testid="text-instagram-research-incomplete">{fmt(failedProfiles)} / {fmt(pendingProfiles)}</strong><small>Current latest saved result state</small></div>
      </div>
    </section>
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
          <div className="inv-kicker">Coverage / Instagram · Tiers 1–5</div>
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
              ? 'Profiles with an existing catalog Instagram URL or a saved research URL candidate.'
              : 'Profiles with an Instagram URL or a completed search that found no supported match.'}
          </p>

          <div className="blk-ig-legend" aria-label="Coverage bar legend">
            <span><i className="url" /> Instagram URL</span>
            {view === 'resolved' && <span><i className="no-candidate" /> No supported match</span>}
          </div>
          <div className="blk-ig-tier-grid">
            {data.tiers.map(tier => <TierCard key={tier.tier} tier={tier} view={view} />)}
          </div>
          <LatestResearchSummary tiers={data.tiers} />
          <HistoryTable history={data.history} />
          <p className="blk-ig-foot" data-testid="text-instagram-research-definition">
            Each profile is counted once using its current-day global Tier 1–5 assignment. URL coverage includes catalog Instagram URLs and saved non-empty research URLs, which are candidates, not approved catalog links. Catalog links and research candidates may overlap, but coverage counts each profile once. The second view also counts completed searches with no candidate as a practical “no supported match,” not proof that no account exists. Failed, incomplete, and not-yet-searched outcomes do not add coverage.
          </p>
        </>
      )}
    </section>
  );
}
