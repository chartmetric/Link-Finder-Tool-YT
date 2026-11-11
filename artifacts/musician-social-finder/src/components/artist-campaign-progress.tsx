import { AlertTriangle, RefreshCw } from 'lucide-react';
import { getGetArtistCampaignProgressQueryKey, useGetArtistCampaignProgress } from '@workspace/api-client-react';

const fmt = (n: number) => n.toLocaleString();
const pct = (n: number) => `${n.toFixed(1)}%`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const STATUS: Record<string, string> = { running: 'Running', stop_requested: 'Stopping', stopped: 'Stopped', completed: 'Completed', paused: 'Paused', budget_exhausted: 'Budget reached' };
const statusLabel = (s: string) => STATUS[s] ?? s.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

export function ArtistCampaignProgress({ className = '' }: { className?: string }) {
  const q = useGetArtistCampaignProgress({ query: {
    queryKey: getGetArtistCampaignProgressQueryKey(),
    refetchInterval: 5000, staleTime: 4000, refetchOnMount: 'always', refetchOnWindowFocus: true,
  } });
  const p = q.data?.progress;
  const failedRefresh = q.isError && !!q.data;
  const stale = !!p?.stale || failedRefresh;

  const shell = `rounded-xl border border-border/80 bg-card text-card-foreground shadow-sm px-4 py-3 ${className}`;
  const Head = (
    <div className="flex items-center gap-2 min-w-0">
      <span className={`h-2 w-2 rounded-full shrink-0 ${p && p.status === 'running' && !stale ? 'bg-primary animate-pulse' : 'bg-muted-foreground/50'}`} aria-hidden />
      <span className="text-[9px] uppercase tracking-widest font-bold text-muted-foreground truncate">Artist campaign · Tier 1–5 Instagram</span>
    </div>
  );

  if (q.isLoading) return (
    <section className={shell} aria-busy="true" aria-label="Artist campaign progress loading" data-testid="campaign-progress-loading">
      {Head}
      <div className="mt-3 h-2 w-full rounded-full bg-muted animate-pulse" />
      <div className="mt-2 flex gap-3"><div className="h-3 w-24 rounded bg-muted animate-pulse" /><div className="h-3 w-32 rounded bg-muted animate-pulse" /></div>
    </section>
  );

  if (q.isError && !q.data) return (
    <section className={`${shell} border-destructive/40`} role="alert" data-testid="campaign-progress-error">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {Head}
        <button type="button" onClick={() => q.refetch()} disabled={q.isFetching} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider hover:bg-muted disabled:opacity-60" data-testid="button-retry-campaign-progress">
          <RefreshCw className={`h-3 w-3 ${q.isFetching ? 'animate-spin' : ''}`} /> Retry
        </button>
      </div>
      <p className="mt-2 text-xs text-destructive font-medium">Campaign progress unavailable. No numbers are shown rather than guessing.</p>
    </section>
  );

  if (!p) return (
    <section className={shell} role="status" data-testid="campaign-progress-empty">
      {Head}
      <p className="mt-1.5 text-xs text-muted-foreground">No continuous artist campaign has been recorded yet. This panel is read-only and never starts paid work.</p>
    </section>
  );

  const value = Math.min(100, Math.max(0, p.processedPercent));
  const budgetPct = p.maximumSpendUsd > 0 ? Math.min(100, (p.reservedUsd / p.maximumSpendUsd) * 100) : 0;
  const updated = new Date(p.updatedAt);

  return (
    <section className={`${shell} ${stale ? 'border-amber-500/50' : ''}`} aria-labelledby="campaign-progress-title" data-testid="section-campaign-progress">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {Head}
        <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
          <span className="rounded border border-border bg-background px-1.5 py-0.5 font-bold uppercase tracking-wider text-foreground" data-testid="status-campaign">Last recorded: {statusLabel(p.status)}</span>
          <span title={updated.toLocaleString()}>Updated {updated.toLocaleTimeString()}</span>
          {q.isFetching && <RefreshCw className="h-3 w-3 animate-spin" aria-label="Refreshing" />}
        </div>
      </div>

      <div className="mt-2.5 grid gap-x-6 gap-y-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-end">
        <div className="min-w-0">
          <h2 id="campaign-progress-title" className="flex flex-wrap items-baseline gap-x-2 leading-none">
            <span className="text-2xl font-extrabold tracking-tight tabular-nums" data-testid="text-campaign-percent">{pct(value)}</span>
            <span className="text-xs font-semibold text-muted-foreground tabular-nums" data-testid="text-campaign-processed"><b className="text-foreground">{fmt(p.processedArtists)}</b> of {fmt(p.totalArtists)} artists processed</span>
          </h2>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Artists processed in the whole campaign queue" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(value.toFixed(1))} aria-valuetext={`${fmt(p.processedArtists)} of ${fmt(p.totalArtists)} artists processed, ${pct(value)}`}>
            <div className={`h-full rounded-full transition-transform duration-700 ease-out origin-left ${stale ? 'bg-amber-500' : 'bg-primary'}`} style={{ transform: `scaleX(${value / 100})` }} />
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-extrabold tracking-tight tabular-nums text-primary" data-testid="text-campaign-success-rate">{p.successRate === null ? 'n/a' : pct(p.successRate)}</span>
            <span className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground">Success rate</span>
          </div>
          <p className="mt-1 text-[10px] leading-snug text-muted-foreground">Likely matches / checked artists ({fmt(p.likelyMatches)} / {fmt(p.checkedArtists)}). Review suggestions, not confirmed ownership.</p>
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 border-t border-border/60 pt-2.5 text-[11px]">
        {[
          ['Likely matches', fmt(p.likelyMatches), 'likely'],
          ['Checked, not accepted', fmt(p.notAcceptedArtists), 'not-accepted'],
          ['Incomplete', fmt(p.incompleteArtists), 'incomplete'],
        ].map(([k, v, id]) => (
          <div key={id} className="flex items-baseline gap-1.5"><dt className="text-muted-foreground">{k}</dt><dd className="font-bold tabular-nums" data-testid={`text-campaign-${id}`}>{v}</dd></div>
        ))}
        <div className="flex items-center gap-1.5 sm:ml-auto">
          <dt className="text-muted-foreground">Reserved</dt>
          <dd className="font-bold tabular-nums" data-testid="text-campaign-budget">{usd(p.reservedUsd)} <span className="font-normal text-muted-foreground">/ {usd(p.maximumSpendUsd)} cap</span></dd>
          <span className="hidden sm:block h-1 w-12 overflow-hidden rounded-full bg-muted" aria-hidden><span className="block h-full bg-muted-foreground/60 origin-left" style={{ transform: `scaleX(${budgetPct / 100})` }} /></span>
        </div>
      </dl>

      <p className="mt-2 text-[11px] text-muted-foreground" data-testid="text-campaign-worker">
        Worker location: workspace, separate from this website. {p.workerStatus === 'recent_activity'
          ? 'Recent checkpoint activity recorded; this is not a live worker connection.'
          : p.workerStatus === 'stale'
            ? 'No fresh worker checkpoint. The worker may be stopped or disconnected.'
            : 'Last recorded worker state is not running.'}
        {' '}This read-only page never starts or retries paid work.
      </p>
      <p className="mt-1 text-[10px] font-mono text-muted-foreground break-all" data-testid="text-campaign-identity">
        Campaign: {p.campaignId} · Snapshot saved {new Date(p.capturedAt).toLocaleString()}
      </p>

      <details className="mt-2.5 border-t border-border/60 pt-2" data-testid="campaign-tier-details">
        <summary className="w-fit cursor-pointer rounded text-xs font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Progress by artist tier
        </summary>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Tiers are frozen at queue approval, not current catalog tiers. Likely-match rate = likely matches / checked artists.
          Incomplete artists are processed but not checked and are excluded from that rate. Suggestions are not confirmed ownership.
        </p>
        {p.tierBreakdown ? (
          <ul className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-5" aria-label="Progress by frozen artist tier">
            {p.tierBreakdown.map(t => (
              <li key={t.tier} className="min-w-0 rounded-lg border border-border bg-background/50 p-3" data-testid={`campaign-tier-${t.tier}`}>
                <h3 className="text-xs font-bold">Tier {t.tier}</h3>
                <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                  <b className="text-foreground">{fmt(t.processedArtists)} / {fmt(t.totalArtists)}</b> processed ({pct(t.processedPercent)})
                </p>
                <dl className="mt-2 space-y-1 text-[11px] tabular-nums">
                  <div className="flex flex-wrap justify-between gap-x-2"><dt className="text-muted-foreground">Likely-match rate</dt><dd className="font-bold text-primary">{t.successRate === null ? 'n/a' : pct(t.successRate)}</dd></div>
                  <div className="flex flex-wrap justify-between gap-x-2"><dt className="text-muted-foreground">Likely / checked</dt><dd className="font-semibold">{fmt(t.likelyMatches)} / {fmt(t.checkedArtists)}</dd></div>
                  <div className="flex flex-wrap justify-between gap-x-2"><dt className="text-muted-foreground">Checked, not accepted</dt><dd>{fmt(t.notAcceptedArtists)}</dd></div>
                  <div className="flex flex-wrap justify-between gap-x-2"><dt className="text-muted-foreground">Incomplete</dt><dd>{fmt(t.incompleteArtists)}</dd></div>
                </dl>
                {t.checkedArtists === 0 && <p className="mt-2 text-[10px] text-muted-foreground">No artists checked yet.</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground" role="status" data-testid="campaign-tier-unavailable">
            {p.tierBreakdownUnavailableReason ?? 'Tier details are not available for this campaign.'}
          </p>
        )}
      </details>

      {stale && (
        <p className="mt-2.5 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-300" role="alert" data-testid="text-campaign-stale">
          <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" />
          {failedRefresh ? 'Refresh failed. Showing the last loaded numbers, which may be out of date.' : 'Campaign data is stale. Numbers reflect the last recorded update and may not match current work.'}
          {failedRefresh && <button type="button" onClick={() => q.refetch()} className="ml-auto underline font-bold" data-testid="button-retry-campaign-stale">Retry</button>}
        </p>
      )}
    </section>
  );
}
