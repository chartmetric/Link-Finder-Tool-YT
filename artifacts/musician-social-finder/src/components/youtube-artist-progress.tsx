import {RefreshCw, AlertTriangle} from 'lucide-react';
import {useGetYoutubeArtistProgress, getGetYoutubeArtistProgressQueryKey} from '@workspace/api-client-react';

const fmt = (n: number) => n.toLocaleString();
const pct = (n: number) => `${n.toFixed(1)}%`;
export function YoutubeArtistProgress({className = ''}: {className?: string}) {
  const q = useGetYoutubeArtistProgress({query: {
    queryKey: getGetYoutubeArtistProgressQueryKey(), refetchInterval: 15000,
    staleTime: 5000, refetchOnMount: 'always', refetchOnWindowFocus: true,
  }});
  const p = q.data?.progress;
  const campaign = p?.runId === 'full-tiers-1-5-no-youtube-uncapped';
  const shell = `rounded-xl border border-border/80 bg-card text-card-foreground shadow-sm px-4 py-3 ${className}`;
  const retry = <button type="button" onClick={() => q.refetch()} disabled={q.isFetching}
    aria-label="Refresh saved YouTube progress"
    className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-semibold hover:bg-muted disabled:opacity-60">
    <RefreshCw className={`h-3 w-3 ${q.isFetching ? 'animate-spin' : ''}`} /> Refresh
  </button>;
  const head = <div className="flex items-center gap-2 min-w-0">
    <span className="h-2 w-2 shrink-0 rounded-full bg-primary/60" aria-hidden />
    <span className="text-[9px] uppercase tracking-widest font-bold text-muted-foreground">{campaign ? 'YouTube campaign' : 'Artist test'} · Tier 1–5{!campaign && ' YouTube'}</span>
  </div>;
  if (q.isLoading) return <section className={shell} aria-label="Loading YouTube progress" aria-busy="true">
    {head}<div className="mt-3 h-2 rounded-full bg-muted animate-pulse" />
  </section>;
  if (q.isError && !q.data) return <section className={shell} role="alert">
    <div className="flex flex-wrap justify-between items-center gap-2">{head}{retry}</div>
    <p className="mt-2 text-xs text-destructive">YouTube progress unavailable. No numbers are shown rather than guessing.</p>
  </section>;
  if (!p) return <section className={shell} role="status">
    <div className="flex flex-wrap justify-between items-center gap-2">{head}{retry}</div>
    <p className="mt-2 text-xs text-muted-foreground">No saved YouTube run yet. Viewing this card never starts paid work.</p>
  </section>;
  const active = p.status === 'running';
  const stale = q.isError || (active && Date.now() - Date.parse(p.updatedAt) > 120000);
  const status = active ? 'Last recorded: running' : p.status === 'stopped' ? 'Stopped'
    : p.pendingCandidates > 0 ? 'Checks incomplete' : 'Completed';
  const stats = [
    ['Likely matches', p.likelyMatches],
    ['Checked, not accepted', p.notAcceptedArtists],
    ['No channel found', p.noChannelFound],
  ] as const;
  return <section className={`${shell} ${stale ? 'border-amber-500/50' : ''}`}
    aria-labelledby="youtube-progress-title" data-testid="section-youtube-progress">
    <div className="flex flex-wrap justify-between items-center gap-2">
      {head}
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span className="rounded border border-border bg-background px-1.5 py-0.5 font-bold uppercase tracking-wider text-foreground">{status}</span>
        <span title={new Date(p.updatedAt).toLocaleString()}>Updated {new Date(p.updatedAt).toLocaleTimeString()}</span>
        {retry}
      </div>
    </div>
    {campaign && <p className="mt-2 text-[11px] text-muted-foreground">Fixed starting group: Tier 1–5 artists without a catalog YouTube link. Having an Instagram link does not exclude them.</p>}
    <div className="mt-2.5 grid gap-x-6 gap-y-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] items-end">
      <div className="min-w-0">
        <h2 id="youtube-progress-title" className="flex flex-wrap items-baseline gap-x-2 leading-none">
          <span className="text-2xl font-extrabold tracking-tight tabular-nums">{pct(p.processedPercent)}</span>
          <span className="text-xs font-semibold text-muted-foreground tabular-nums">
            <b className="text-foreground">{fmt(p.searchedArtists)}</b> of {fmt(p.totalArtists)} artists {campaign ? 'processed for YouTube' : 'searched'}
          </span>
        </h2>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar"
          aria-label={campaign ? 'Artists processed in the YouTube campaign' : 'Artists searched in the approved YouTube test'} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Number(p.processedPercent.toFixed(1))}
          aria-valuetext={`${p.searchedArtists} of ${p.totalArtists} artists searched`}>
          <div className="h-full rounded-full bg-primary origin-left transition-transform duration-700"
            style={{transform: `scaleX(${p.processedPercent / 100})`}} />
        </div>
      </div>
      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-extrabold tracking-tight text-primary tabular-nums">{p.successRate === null ? 'n/a' : pct(p.successRate)}</span>
          <span className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground">Success rate</span>
        </div>
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
          Likely matches / checked artists ({fmt(p.likelyMatches)} / {fmt(p.checkedArtists)}). Suggestions, not confirmed ownership.
        </p>
      </div>
    </div>
    <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 border-t border-border/60 pt-2.5 text-[11px]">
      {stats.map(([label, value]) => <div key={label} className="flex items-baseline gap-1.5">
        <dt className="text-muted-foreground">{label}</dt><dd className="font-bold tabular-nums">{fmt(value)}</dd>
      </div>)}
      <div className="flex items-baseline gap-1.5 sm:ml-auto">
        <dt className="text-muted-foreground">Reserved</dt>
        <dd className="font-bold tabular-nums">${p.reservedUsd.toFixed(2)} <span className="font-normal text-muted-foreground">{p.maximumSpendUsd === null ? '· No total cap' : `/ $${p.maximumSpendUsd.toFixed(2)} cap`}</span></dd>
      </div>
    </dl>
    <p className="mt-2 text-[11px] text-muted-foreground">
      {campaign ? 'Saved campaign progress; viewing this card never starts or retries paid work.' : 'Saved test results, not the continuous campaign.'}
      {!!p.deferredArtists && ` ${fmt(p.deferredArtists)} artists deferred to preserve prior paid attempts or because catalog eligibility changed.`}
      {p.pendingCandidates > 0 && ` ${fmt(p.pendingCandidates)} candidates still need more checking.`}
    </p>
    <details className="mt-2 border-t border-border/60 pt-2">
      <summary className="w-fit cursor-pointer rounded text-xs font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        How these numbers are counted
      </summary>
      <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
        <p>{campaign ? 'This is the frozen Tier 1–5 queue missing catalog YouTube links. It is separate from the Instagram queue.' : `This is the approved ${fmt(p.totalArtists)}-artist test, not all Tier 1–5 artists.`} Search progress is separate from ownership checks.</p>
        <p>{fmt(p.checkedArtists)} of {fmt(p.artistsWithCandidates)} artists with candidates have at least one recorded ownership assessment.
          Multiple candidates count as one artist. An assessment can be uncertain or identify a Topic or organization channel.</p>
        <p>{fmt(p.uncheckedArtists)} artists with candidates have no completed ownership assessment.
          {` ${fmt(p.heldCandidates)} candidate checks were held because their evidence exceeded the approved size limit.`}</p>
        <p>“No channel found” means a completed search returned no candidate; it does not prove an artist has no channel.
          Held or failed checks are not counted as rejections. Reserved funds are estimates, not billed totals.</p>
        <p>Reading or refreshing this card never starts, resumes or retries paid work.</p>
      </div>
    </details>
    {stale && <p className="mt-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-300" role="alert">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {q.isError
        ? 'Refresh failed. Showing the last loaded YouTube results.' : 'No recent update. These saved numbers may be out of date.'}
    </p>}
  </section>;
}
