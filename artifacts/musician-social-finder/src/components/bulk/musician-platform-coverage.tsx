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
const batchLinks = (tier: MusicianPlatformCoverageTiersItem) => (tier.testLikelyUrls ?? 0) + (tier.testTopicUrls ?? 0);

function TierRow({ tier, view, platform }: { tier: MusicianPlatformCoverageTiersItem; view: View; platform: CoveragePlatform }) {
  const links = tier.catalogUrls + tier.supportedResearchUrls + (tier.campaignLikelyUrls ?? 0) + batchLinks(tier);
  const shown = view === 'urls' ? links : links + tier.noSupportedMatch;
  const id = `${platform}-tier-${tier.tier}`;
  return (
    <li className="mpc-row" data-testid={`card-platform-coverage-${id}`}>
      <span className="mpc-tier">Tier {tier.tier}</span>
      <div className="mpc-track" role="img" aria-label={`Tier ${tier.tier}: ${fmt(links)} of ${fmt(tier.totalProfiles)} with a catalog link, supported research or likely match${view === 'resolved' ? `, plus ${fmt(tier.noSupportedMatch)} with no supported match` : ''}`}>
        <span className="mpc-seg catalog" style={{ width: w(tier.catalogUrls, tier.totalProfiles) }} />
        <span className="mpc-seg research" style={{ width: w(tier.supportedResearchUrls, tier.totalProfiles) }} />
        <span className="mpc-seg campaign" style={{ width: w(tier.campaignLikelyUrls ?? 0, tier.totalProfiles) }} />
        <span className="mpc-seg batch" style={{ width: w(tier.testLikelyUrls ?? 0, tier.totalProfiles) }} />
        <span className="mpc-seg topic" style={{ width: w(tier.testTopicUrls ?? 0, tier.totalProfiles) }} />
        {view === 'resolved' && <span className="mpc-seg nomatch" style={{ width: w(tier.noSupportedMatch, tier.totalProfiles) }} />}
      </div>
      <strong className="mpc-pct" data-testid={`text-platform-coverage-${id}-percent`}>{pct(shown, tier.totalProfiles)}</strong>
      <span className="mpc-count" data-testid={`text-platform-coverage-${id}-count`}>{fmt(shown)} / {fmt(tier.totalProfiles)}</span>
      <details className="mpc-more">
        <summary data-testid={`button-platform-coverage-${id}-details`}>Breakdown</summary>
        <dl>
          <div><dt>Catalog link</dt><dd>{fmt(tier.catalogUrls)}</dd></div>
          <div><dt>Supported research link</dt><dd>{fmt(tier.supportedResearchUrls)}</dd></div>
          <div><dt>Additional campaign likely matches (review)</dt><dd>{fmt(tier.campaignLikelyUrls ?? 0)}</dd></div>
          {platform === 'youtube' && <>
            <div><dt>Batch artist-channel suggestions (review)</dt><dd>{fmt(tier.testLikelyUrls ?? 0)}</dd></div>
            <div><dt>Batch Topic-only suggestions (auto-generated)</dt><dd>{fmt(tier.testTopicUrls ?? 0)}</dd></div>
          </>}
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
    query: { queryKey: getGetMusicianPlatformCoverageQueryKey(platform), staleTime: 10_000, refetchInterval: 15_000 },
  });
  const data = q.data && q.data.platform === platform ? q.data : undefined;
  const name = NAME[platform];
  const usable = data && (data.snapshotStatus === 'current' || data.snapshotStatus === 'recent');
  const tiers = (data?.tiers ?? []).filter(t => Number.isInteger(t.tier) && t.tier >= 1 && t.tier <= 5);
  const total = tiers.reduce((s, t) => s + t.totalProfiles, 0);
  const catalog = tiers.reduce((s, t) => s + t.catalogUrls, 0);
  const likely = tiers.reduce((s, t) => s + (t.campaignLikelyUrls ?? 0), 0);
  const batch = tiers.reduce((s, t) => s + (t.testLikelyUrls ?? 0), 0);
  const topic = tiers.reduce((s, t) => s + (t.testTopicUrls ?? 0), 0);
  const links = tiers.reduce((s, t) => s + t.catalogUrls + t.supportedResearchUrls + (t.campaignLikelyUrls ?? 0) + batchLinks(t), 0);
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
          {data.campaignError && <p className="blk-ig-stale" role="status">{data.campaignError}</p>}
          <div className="mpc-hero">
            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground">Catalog + research + suggestions</p>
              <strong data-testid="text-platform-coverage-total-percent">{pct(view === 'urls' ? links : links + noMatch, total)}</strong>
              <span data-testid="text-platform-coverage-total">
                {fmt(links)} of {fmt(total)} Tier 1–5 artists have a {name} link or likely match
                {view === 'resolved' && <>, {fmt(noMatch)} more searched with no match</>}
              </span>
            </div>
            <div className="blk-ig-toggle mpc-view" role="group" aria-label={`${name} coverage view`}>
              <button type="button" aria-pressed={view === 'urls'} onClick={() => setView('urls')} data-testid="button-platform-view-urls">Links + likely</button>
              <button type="button" aria-pressed={view === 'resolved'} onClick={() => setView('resolved')} data-testid="button-platform-view-resolved">Plus no match</button>
            </div>
          </div>
          <p className="mpc-foot" data-testid="text-platform-coverage-sources">
            Catalog: {fmt(catalog)} ({pct(catalog, total)}) · Additional campaign likely matches: {fmt(likely)}.
            {platform === 'youtube' && <> Batch suggestions: {fmt(batch)} artist-channel and {fmt(topic)} Topic-only (auto-generated).</>}
            {' '}Each artist counts once. Likely matches need review and are not catalog additions.
          </p>
          {tiers.length === 0 ? (
            <p className="blk-ig-message" data-testid="text-platform-coverage-empty">No tiered artists in this snapshot.</p>
          ) : (
            <ul className="mpc-rows">{tiers.map(t => <TierRow key={t.tier} tier={t} view={view} platform={platform} />)}</ul>
          )}
          <div className="mpc-legend" aria-hidden="true">
            <span><i className="catalog" />Catalog</span>
            <span><i className="research" />Supported research</span>
            <span><i className="campaign" />Campaign likely · review</span>
            {platform === 'youtube' && <>
              <span><i className="batch" />Batch artist channel · review</span>
              <span><i className="topic" />Batch Topic only · auto-generated</span>
            </>}
            {view === 'resolved' && <span><i className="nomatch" />No match (not a link)</span>}
          </div>
          <p className="mpc-foot" data-testid="text-platform-coverage-meta">
            {fmt(unresolved)} unresolved and {fmt(open)} failed, pending or unsearched are not counted.
            {' '}Tier snapshot {data.snapshotAt ? new Date(data.snapshotAt).toLocaleString() : 'n/a'}.
            {' '}Catalog/research checked {new Date(data.catalogGeneratedAt ?? data.generatedAt).toLocaleTimeString()}.
            {platform === 'youtube' && <> Batch evidence {data.testObservedAt ? new Date(data.testObservedAt).toLocaleString() : 'not yet recorded'}.</>}
            {' '}Campaign {data.campaignStatus ?? 'unavailable'}{data.campaignObservedAt && <> · worker evidence {new Date(data.campaignObservedAt).toLocaleTimeString()}</>}.
          </p>
          {platform === 'youtube' && <details className="mpc-more">
            <summary>What is included?</summary>
            <p className="mpc-foot">Includes catalog links, saved channel-review batch suggestions and continuous-campaign likely matches for current Tier 1–5 artists. Older separate investigations are not included. Each artist counts once: catalog first, then supported research, campaign suggestions, and batch suggestions. Artists with both a suggested artist channel and a Topic channel count in the artist-channel group. Topic channels are auto-generated music pages, not artist-managed channels. Catalog links are not reclassified by channel type here. Suggestions are not approvals or proof of channel management. Raw candidates, held conflicts and unfinished checks do not count as links. “No match” means a completed search found no supported link, not proof that no channel exists.</p>
          </details>}
        </>
      )}
    </div>
  );
}
