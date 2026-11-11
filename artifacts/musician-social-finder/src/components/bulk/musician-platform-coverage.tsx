import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  getGetMusicianPlatformCoverageQueryKey,
  useGetMusicianPlatformCoverage,
  type MusicianPlatformCoverageTiersItem,
} from '@workspace/api-client-react';
import '@/styles/musician-platform-coverage.css';

export type CoveragePlatform = 'instagram' | 'youtube';
type View = 'urls' | 'resolved';
const NAME: Record<CoveragePlatform, string> = { instagram: 'Instagram', youtube: 'YouTube' };
const fmt = (n: number) => n.toLocaleString();
const pct = (v: number, t: number) => (t > 0 ? `${((100 * v) / t).toFixed(1)}%` : 'N/A');
const w = (v: number, t: number) => (t > 0 ? `${(100 * v) / t}%` : '0%');

function TierRow({ tier, view, platform }: { tier: MusicianPlatformCoverageTiersItem; view: View; platform: CoveragePlatform }) {
  const links = tier.catalogUrls + tier.supportedResearchUrls;
  const shown = view === 'urls' ? links : links + tier.noSupportedMatch;
  const id = `${platform}-tier-${tier.tier}`;
  return (
    <li className="mpc-row" data-testid={`card-platform-coverage-${id}`}>
      <span className="mpc-tier">Tier {tier.tier}</span>
      <div className="mpc-track" role="img" aria-label={`Tier ${tier.tier}: ${fmt(links)} of ${fmt(tier.totalProfiles)} with a link${view === 'resolved' ? `, plus ${fmt(tier.noSupportedMatch)} with no supported match` : ''}`}>
        <span className="mpc-seg catalog" style={{ width: w(tier.catalogUrls, tier.totalProfiles) }} />
        <span className="mpc-seg research" style={{ width: w(tier.supportedResearchUrls, tier.totalProfiles) }} />
        {view === 'resolved' && <span className="mpc-seg nomatch" style={{ width: w(tier.noSupportedMatch, tier.totalProfiles) }} />}
      </div>
      <strong className="mpc-pct" data-testid={`text-platform-coverage-${id}-percent`}>{pct(shown, tier.totalProfiles)}</strong>
      <span className="mpc-count" data-testid={`text-platform-coverage-${id}-count`}>{fmt(shown)} / {fmt(tier.totalProfiles)}</span>
      <details className="mpc-more">
        <summary data-testid={`button-platform-coverage-${id}-details`}>Breakdown</summary>
        <dl>
          <div><dt>Catalog link</dt><dd>{fmt(tier.catalogUrls)}</dd></div>
          <div><dt>Supported research link</dt><dd>{fmt(tier.supportedResearchUrls)}</dd></div>
          <div><dt>No supported match</dt><dd>{fmt(tier.noSupportedMatch)}</dd></div>
          <div><dt>Unresolved candidates (not counted)</dt><dd>{fmt(tier.unresolvedCandidates)}</dd></div>
          <div><dt>Failed</dt><dd>{fmt(tier.failed)}</dd></div>
          <div><dt>Pending</dt><dd>{fmt(tier.pending)}</dd></div>
          <div><dt>Not searched / other incomplete</dt><dd>{fmt(tier.notSearched)}</dd></div>
        </dl>
      </details>
    </li>
  );
}

export function MusicianPlatformCoverage({ platform }: { platform: CoveragePlatform }) {
  const [view, setView] = useState<View>('urls');
  const q = useGetMusicianPlatformCoverage(platform, {
    query: { queryKey: getGetMusicianPlatformCoverageQueryKey(platform), staleTime: 60_000, refetchInterval: 60_000 },
  });
  const data = q.data && q.data.platform === platform ? q.data : undefined;
  const name = NAME[platform];
  const usable = data && (data.snapshotStatus === 'current' || data.snapshotStatus === 'recent');
  const tiers = (data?.tiers ?? []).filter(t => Number.isInteger(t.tier) && t.tier >= 1 && t.tier <= 5);
  const total = tiers.reduce((s, t) => s + t.totalProfiles, 0);
  const links = tiers.reduce((s, t) => s + t.catalogUrls + t.supportedResearchUrls, 0);
  const noMatch = tiers.reduce((s, t) => s + t.noSupportedMatch, 0);
  const unresolved = tiers.reduce((s, t) => s + t.unresolvedCandidates, 0);
  const open = tiers.reduce((s, t) => s + t.failed + t.pending + t.notSearched, 0);

  return (
    <div className="mpc" data-testid={`section-platform-coverage-${platform}`} aria-busy={q.isFetching}>
      {q.isLoading && (
        <div className="mpc-skel" role="status" data-testid="status-platform-coverage-loading">
          <span className="sr-only">Loading {name} coverage</span>
          {[0, 1, 2].map(i => <i key={i} />)}
        </div>
      )}
      {q.isError && !data && (
        <div className="blk-cov-error" role="alert" data-testid="status-platform-coverage-error">
          <p>{name} coverage could not be loaded. Figures are unavailable, not zero.</p>
          <button type="button" className="inv-retry" onClick={() => q.refetch()} disabled={q.isFetching} data-testid="button-retry-platform-coverage">
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}
      {data && !usable && (
        <p className="blk-cov-error" role="status" data-testid="status-platform-coverage-unavailable">
          {name} coverage is unavailable, not zero. {data.snapshotStatus === 'stale' ? 'The tier snapshot is stale.' : 'No tier snapshot is available yet.'}
        </p>
      )}
      {data && usable && (
        <>
          {q.isError && <p className="blk-ig-stale" role="status">Refresh failed. Showing the previous {name} counts.</p>}
          <div className="mpc-hero">
            <div>
              <strong data-testid="text-platform-coverage-total-percent">{pct(view === 'urls' ? links : links + noMatch, total)}</strong>
              <span data-testid="text-platform-coverage-total">
                {fmt(links)} of {fmt(total)} Tier 1–5 artists have a {name} link
                {view === 'resolved' && <>, {fmt(noMatch)} more searched with no match</>}
              </span>
            </div>
            <div className="blk-ig-toggle mpc-view" role="group" aria-label={`${name} coverage view`}>
              <button type="button" aria-pressed={view === 'urls'} onClick={() => setView('urls')} data-testid="button-platform-view-urls">Links</button>
              <button type="button" aria-pressed={view === 'resolved'} onClick={() => setView('resolved')} data-testid="button-platform-view-resolved">Links + no match</button>
            </div>
          </div>
          {tiers.length === 0 ? (
            <p className="blk-ig-message" data-testid="text-platform-coverage-empty">No tiered artists in this snapshot.</p>
          ) : (
            <ul className="mpc-rows">{tiers.map(t => <TierRow key={t.tier} tier={t} view={view} platform={platform} />)}</ul>
          )}
          <div className="mpc-legend" aria-hidden="true">
            <span><i className="catalog" />Catalog</span>
            <span><i className="research" />Supported research</span>
            {view === 'resolved' && <span><i className="nomatch" />No match (not a link)</span>}
          </div>
          <p className="mpc-foot" data-testid="text-platform-coverage-meta">
            {fmt(unresolved)} unresolved and {fmt(open)} failed, pending or unsearched are not counted.
            {' '}Snapshot {data.snapshotAt ? new Date(data.snapshotAt).toLocaleString() : 'n/a'}, updated {new Date(data.generatedAt).toLocaleTimeString()}.
          </p>
          {platform === 'youtube' && <details className="mpc-more">
            <summary>What is included?</summary>
            <p className="mpc-foot">Catalog links cover all artists in these tiers. YouTube research counts currently include the new discovery test only; older investigations are not included. Search candidates are not accepted links; a completed no-match search is not proof that no account exists.</p>
          </details>}
        </>
      )}
    </div>
  );
}
