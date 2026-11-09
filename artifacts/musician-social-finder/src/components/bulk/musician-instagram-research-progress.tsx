import { useEffect, useState } from 'react';
import { CircleAlert, Download, RefreshCw, Square } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getMusicianInstagramResearchNoCandidates,
  getGetMusicianInstagramResearchCoverageQueryKey,
  getGetMusicianInstagramRerunQueryKey,
  useGetMusicianInstagramResearchCoverage,
  getGetMusicianInstagramRerunEligibilityQueryKey,
  useGetMusicianInstagramRerunEligibility,
  useGetMusicianInstagramRerun,
  useStartMusicianInstagramRerun,
  useStopMusicianInstagramRerun,
  type MusicianInstagramResearchTier,
  type MusicianInstagramResearchHistoryDay,
} from '@workspace/api-client-react';
import { apiError, readStorage, writeStorage } from '@/lib/bulk';
import { downloadMusicianInstagramNoCandidatesCsv } from '@/lib/musician-instagram-research-csv';

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
const RERUN_ID_KEY = 'bulk-musician-instagram-rerun:last-run';
const RERUN_PENDING_KEY = 'bulk-musician-instagram-rerun:pending-request';

const statusLabel: Record<string, string> = {
  queued: 'Queued',
  running: 'Searching',
  candidates_found: 'Candidate found',
  no_candidates: 'No candidate',
  failed: 'Failed — review before retrying',
};

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
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ kind: 'status' | 'error'; text: string } | null>(null);
  const qc = useQueryClient();
  const [runId, setRunId] = useState<string | null>(() => readStorage<string | null>(RERUN_ID_KEY, null));
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(() => readStorage<string | null>(RERUN_PENDING_KEY, null));
  const [ackPaid, setAckPaid] = useState(false);
  const eligibility = useGetMusicianInstagramRerunEligibility({
    query: { queryKey: getGetMusicianInstagramRerunEligibilityQueryKey(), refetchOnMount: 'always', retry: false },
  });
  const rerun = useGetMusicianInstagramRerun(runId ?? '', {
    query: {
      queryKey: getGetMusicianInstagramRerunQueryKey(runId ?? ''),
      enabled: !!runId,
      refetchOnMount: 'always',
      refetchInterval: query => query.state.data?.active ? 1500 : false,
      retry: false,
    },
  });
  const startRerun = useStartMusicianInstagramRerun();
  const stopRerun = useStopMusicianInstagramRerun();
  useEffect(() => { writeStorage(RERUN_ID_KEY, runId); }, [runId]);
  useEffect(() => { writeStorage(RERUN_PENDING_KEY, pendingRequestId); }, [pendingRequestId]);
  useEffect(() => {
    if (rerun.data && pendingRequestId === rerun.data.runId) setPendingRequestId(null);
  }, [rerun.data, pendingRequestId]);
  const q = useGetMusicianInstagramResearchCoverage({
    query: {
      queryKey: getGetMusicianInstagramResearchCoverageQueryKey(),
      refetchOnMount: 'always',
      refetchInterval: 5 * 60_000,
      retry: false,
    },
  });
  const data = q.data;
  // Also guard retained React Query data after a failed refresh.
  const snapshotAge = data?.snapshotAt ? Date.now() - Date.parse(data.snapshotAt) : NaN;
  const usableSnapshot = data && (data.snapshotStatus === 'current' || data.snapshotStatus === 'recent')
    && snapshotAge >= 0 && snapshotAge <= 36 * 60 * 60_000;
  const snapshotLabel = data?.snapshotAt
    ? new Date(data.snapshotAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
    : null;

  const downloadNoCandidateExport = async () => {
    setExporting(true);
    setExportMessage(null);
    try {
      const result = await getMusicianInstagramResearchNoCandidates({
        signal: AbortSignal.timeout(60_000),
      });
      downloadMusicianInstagramNoCandidatesCsv(result);
      setExportMessage({
        kind: 'status',
        text: `Downloaded ${result.profiles.length.toLocaleString()} profiles using research saved ${new Date(result.generatedAt).toLocaleString()}.`,
      });
    } catch (error) {
      setExportMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : 'The latest artist export could not be downloaded. Please retry.',
      });
    } finally {
      setExporting(false);
    }
  };
  const start = () => {
    if (!eligibility.data || eligibility.data.count < 1 || !ackPaid || startRerun.isPending || pendingRequestId) return;
    const requestId = crypto.randomUUID();
    setPendingRequestId(requestId);
    startRerun.mutate({
      data: {
        requestId,
        selectionToken: eligibility.data.selectionToken,
        expectedCount: eligibility.data.count,
        paidAcknowledged: true,
      },
    }, {
      onSuccess: run => {
        setRunId(run.runId);
        setPendingRequestId(null);
        setAckPaid(false);
        void qc.invalidateQueries({ queryKey: getGetMusicianInstagramRerunEligibilityQueryKey() });
        void qc.invalidateQueries({ queryKey: getGetMusicianInstagramResearchCoverageQueryKey() });
      },
      onError: error => {
        const status = (error as { status?: number }).status;
        if (status === 400 || status === 409) setPendingRequestId(null);
      },
    });
  };
  const startError = startRerun.isError
    ? apiError(startRerun.error, 'The start response was not confirmed.')
    : '';
  const blockNewRerun = !!rerun.data?.active || (rerun.data?.status === 'needs_review' && rerun.data.paidAdmissionsOccurred);

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
          <button type="button" className="inv-retry" onClick={downloadNoCandidateExport} disabled={exporting} data-testid="button-download-instagram-no-candidates">
            <Download size={12} className={exporting ? 'inv-spin' : ''} /> {exporting ? 'Preparing CSV' : 'Download no-URL CSV'}
          </button>
        </div>
      </div>

      {exportMessage && <p className="blk-ig-message" role={exportMessage.kind === 'error' ? 'alert' : 'status'} data-testid="status-instagram-no-candidate-export">{exportMessage.text}</p>}

      {q.isLoading && <p className="blk-ig-message" role="status" data-testid="status-instagram-research-loading">Loading saved Instagram research counts…</p>}

      {q.isError && !data && (
        <div className="blk-cov-error" role="alert" data-testid="status-instagram-research-error">
          <p>Instagram research counts could not be loaded. These figures are unavailable, not zero.</p>
          <button type="button" className="inv-retry" onClick={() => q.refetch()} disabled={q.isFetching} data-testid="button-retry-instagram-research">
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}

      {data && !usableSnapshot && (
        <p className="blk-cov-error" role="status" data-testid="status-instagram-research-unavailable">
          Instagram coverage is unavailable, not zero. {snapshotLabel
            ? `The latest tier snapshot (${snapshotLabel}) is stale or unusable; snapshots must be no more than 36 hours old.`
            : 'No musician tier snapshot is available.'} Waiting for a recent completed snapshot.
        </p>
      )}

      {data && usableSnapshot && (
        <>
          {q.isError && <p className="blk-ig-stale" role="status">The latest refresh failed; showing the previous coverage counts.</p>}
          <p className="blk-ig-message" role="status" data-testid="text-instagram-research-snapshot">
            Tier snapshot: {snapshotLabel}.
            {data.snapshotAt?.slice(0, 10) !== new Date().toISOString().slice(0, 10)
              && ' Showing the recent snapshot while the next UTC-day tier refresh is pending (36-hour maximum age).'}
          </p>

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
            Each profile is counted once using its global Tier 1–5 assignment from the single tier snapshot shown above. URL coverage includes catalog Instagram URLs and saved non-empty research URLs, which are candidates, not approved catalog links. Catalog links and research candidates may overlap, but coverage counts each profile once. The second view also counts completed searches with no candidate as a practical “no supported match,” not proof that no account exists. Failed, incomplete, and not-yet-searched outcomes do not add coverage.
          </p>
        </>
      )}

      <section className="blk-ig-rerun" aria-labelledby="blk-ig-rerun-title" data-testid="section-instagram-no-match-rerun">
        <div className="blk-ig-rerun-head">
          <div>
            <div className="inv-kicker">Paid recheck / Instagram only</div>
            <h3 id="blk-ig-rerun-title">Recheck completed no-match profiles</h3>
          </div>
          <button type="button" className="inv-retry" onClick={() => eligibility.refetch()} disabled={eligibility.isFetching} data-testid="button-refresh-rerun-eligibility">
            <RefreshCw size={12} className={eligibility.isFetching ? 'inv-spin' : ''} /> {eligibility.isFetching ? 'Checking' : 'Refresh count'}
          </button>
        </div>
        {eligibility.isLoading && <p role="status" className="blk-ig-message">Checking which completed no-match profiles are eligible…</p>}
        {eligibility.isError && !eligibility.data && <p className="blk-ig-rerun-error" role="alert" data-testid="status-rerun-eligibility-error">
          Eligibility is unavailable, not zero. No paid requests have started.
        </p>}
        {eligibility.data && (
          <>
            <p className="blk-ig-rerun-count" data-testid="text-rerun-eligible-count">
              <strong>{fmt(eligibility.data.count)}</strong> eligible profiles
              <span>Completed Serper searches with no Instagram candidate, still matching the saved artist identity and current Tier 1–3 catalog.</span>
            </p>
            {eligibility.isError && <p className="blk-ig-stale" role="status">The latest count refresh failed; the previous count may be stale.</p>}
            {eligibility.data.count === 0 ? (
              <p className="blk-ig-message">There are no eligible profiles to recheck.</p>
            ) : (
              <>
                <div className="blk-ig-rerun-warning"><CircleAlert size={15} /><p>This starts paid Serper requests for Instagram only. Each eligible profile may be charged again. Existing profile and artist IDs are preserved. Results are unverified candidates, and a failed or uncertain request will not be replayed.</p></div>
                <label className="blk-ig-rerun-ack">
                  <input type="checkbox" checked={ackPaid} onChange={event => setAckPaid(event.target.checked)} data-testid="checkbox-ack-instagram-rerun" />
                  I explicitly approve paid Serper requests for all {fmt(eligibility.data.count)} eligible profiles.
                </label>
                <div className="blk-ig-rerun-actions">
                  <button type="button" className="inv-submit" disabled={!ackPaid || startRerun.isPending || !!pendingRequestId || blockNewRerun} onClick={start} data-testid="button-start-instagram-rerun">
                    {startRerun.isPending ? 'Preparing rerun' : `Recheck ${fmt(eligibility.data.count)} profiles`}
                  </button>
                  {pendingRequestId && !runId && (
                    <button type="button" className="blk-link" onClick={() => setRunId(pendingRequestId)} data-testid="button-check-pending-instagram-rerun">
                      Check the previous start request
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}
        {startError && (
          <p className="blk-ig-rerun-error" role="alert" data-testid="status-instagram-rerun-start-error">
            {startError} Do not start another rerun until you check the previous request status.
          </p>
        )}
        {runId && (
          <div className="blk-ig-rerun-run" data-testid="section-instagram-rerun-run">
            <div className="blk-ig-rerun-run-head">
              <div>
                <strong>Rerun progress</strong>
                {rerun.data && <span data-testid="text-instagram-rerun-status">
                  {rerun.data.status === 'prepared' && rerun.data.active && rerun.data.profiles.length === 0 ? 'preparing selection' : rerun.data.status.replaceAll('_', ' ')} · {fmt(rerun.data.finished)} of {fmt(rerun.data.count)} finished
                </span>}
              </div>
              {rerun.data?.active && (
                <button type="button" className="blk-ig-stop" disabled={stopRerun.isPending} onClick={() => stopRerun.mutate({ runId }, {
                  onSuccess: saved => qc.setQueryData(getGetMusicianInstagramRerunQueryKey(runId), saved),
                })} data-testid="button-stop-instagram-rerun">
                  <Square size={12} /> {stopRerun.isPending ? 'Stopping' : 'Stop queued searches'}
                </button>
              )}
            </div>
            {rerun.isLoading && <p role="status" className="blk-ig-message">Loading saved rerun outcomes…</p>}
            {rerun.isError && <p className="blk-ig-rerun-error" role="alert" data-testid="status-instagram-rerun-load-error">
              Saved rerun status is unavailable. Failed or uncertain work is not automatically replayed.
            </p>}
            {stopRerun.isError && <p className="blk-ig-rerun-error" role="alert">The stop state could not be confirmed. Requests already sent may still complete.</p>}
            {rerun.data?.status === 'needs_review' && <p className="blk-ig-stale" role="status">Some outcomes need review. Do not rerun uncertain profiles automatically.</p>}
            {rerun.data?.status === 'needs_review' && !rerun.data.paidAdmissionsOccurred && <p className="blk-ig-message" role="status">Preparation stopped before any paid search was admitted. Refresh eligibility before starting a new run.</p>}
            {rerun.data?.status === 'stopped' && <p className="blk-ig-message" role="status">Queued profiles were left untouched. In-flight requests may still have completed.</p>}
            {rerun.data && (
              <ul className="blk-ig-rerun-list" aria-label="Per-profile rerun outcomes">
                {rerun.data.profiles.map(profile => (
                  <li key={profile.profileId} data-testid={`row-instagram-rerun-profile-${profile.profileId}`}>
                    <div><strong>{profile.artist}</strong><small>Tier {profile.tier} · profile {profile.profileId}</small></div>
                    <span className={`blk-ig-outcome status-${profile.status}`} data-testid={`text-instagram-rerun-outcome-${profile.profileId}`}>
                      {profile.status === 'running' && !rerun.data.active ? 'Unknown after interruption — review' : profile.status === 'queued' && !rerun.data.active ? 'Not started — review run' : statusLabel[profile.status] ?? profile.status}
                    </span>
                    {profile.instagramUrls.length > 0 && <small className="blk-ig-profile-urls">{profile.instagramUrls.map(url => <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}</small>}
                    {profile.error && <small className="blk-ig-profile-error" role="alert">{profile.error}</small>}
                  </li>
                ))}
              </ul>
            )}
            {pendingRequestId === runId && rerun.isError && (rerun.error as { status?: number }).status === 404 && (
              <button type="button" className="blk-link" onClick={() => { setPendingRequestId(null); setRunId(null); }} data-testid="button-clear-unaccepted-instagram-rerun">
                Confirm no run was saved
              </button>
            )}
          </div>
        )}
      </section>
    </section>
  );
}
