import { forwardRef } from 'react';
import { ArrowDown, CircleAlert, RefreshCw } from 'lucide-react';
import type { BulkBrandRun, BulkBrandItemStage } from '@workspace/api-client-react';
import { KIND_META, apiError, isActiveRun, kindOf, scopedRunProgress, runKinds, type ProfileKind } from '@/lib/bulk';

type Props = {
  kind: ProfileKind;
  runId: string;
  run?: BulkBrandRun;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  isError: boolean;
  onRetry: () => void;
  onOpenDetail: () => void;
};

const TERMINAL: Record<string, string> = {
  completed: 'Finished: all profiles processed',
  stopped: 'Stopped by request',
  interrupted: 'Paused by server restart; needs resume',
};

const STAGE_LABELS: Record<BulkBrandItemStage, string> = {
  reading_reference: 'Reading reference profile',
  searching_platforms: 'Searching platforms',
  verifying_candidates: 'Verifying candidates',
};

export const RunProgress = forwardRef<HTMLElement, Props>(function RunProgress({ kind, runId, run, loading, fetching, error, isError, onRetry, onOpenDetail }, ref) {
  const active = isActiveRun(run);
  const preparing = run?.preparation?.status === 'selecting';
  const cont = run?.continuous;
  const scoped = run ? scopedRunProgress(run, kind) : null;
  const cur = scoped?.current;
  const o = scoped?.overall;
  const processed = scoped?.processed ?? 0;
  const cap = scoped?.cap;
  const chunkDone = cur ? cur.completed + cur.failed : 0;
  const chunkTotal = cur?.total ?? 0;
  let pct: number | null = null;
  let barLabel = '';
  if (run && !cont) { pct = chunkTotal ? chunkDone / chunkTotal : 0; barLabel = `${chunkDone} of ${chunkTotal} processed`; }
  else if (run && cap) { pct = Math.min(1, processed / cap); barLabel = `${processed} of ${cap} capped profiles processed`; }
  const chunkPct = chunkTotal ? chunkDone / chunkTotal : 0;
  const runningItems = run ? run.items.filter(i => i.status === 'running' && kindOf(i.candidate) === kind) : [];
  const kinds = run ? runKinds(run) : [];
  const rootId = run?.id ?? runId;

  return (
    <section ref={ref} tabIndex={-1} className="blk-rp" aria-labelledby="blk-rp-title" data-testid="section-run-progress">
      <div className="blk-rp-head">
        <div className="blk-rp-id">
          <span className="inv-kicker">{KIND_META[kind].plural} run</span>
          <h2 id="blk-rp-title" className="inv-mono" data-testid="text-rp-run-id">{rootId.slice(0, 8)}{cont && <> <span className="blk-tag">continuous</span></>}</h2>
        </div>
        {run && <strong className={`blk-pill r-${run.status}`} data-testid="status-rp">{preparing && active ? 'preparing' : run.status}</strong>}
        <span className="blk-rp-live inv-mono" role="status" aria-live="polite" data-testid="status-rp-sync">
          {loading ? 'Loading run' : isError ? (run ? 'Stale: polling failed' : 'Could not load') : active ? (fetching ? 'Refreshing' : 'Live, every 3s') : run ? 'Final state' : ''}
          {active && !isError && <i className="blk-rp-dot" aria-hidden="true" />}
        </span>
        <button type="button" className="inv-retry blk-rp-open" onClick={onOpenDetail} data-testid="button-rp-open-detail"><ArrowDown size={13} /> Open run monitor</button>
      </div>

      {loading && <div className="blk-rp-skel" aria-busy="true"><i /><i /><i /></div>}
      {isError && (
        <div className="blk-rp-err" role="alert" data-testid="status-rp-error">
          <CircleAlert size={14} /> {run ? 'Lost contact; showing last known numbers.' : apiError(error, 'This run could not be loaded.')}
          <button type="button" className="inv-retry" onClick={onRetry} data-testid="button-rp-retry"><RefreshCw size={12} /> Retry</button>
        </div>
      )}

      {run && cur && o && (
        <>
          {kinds.length > 1 && <p className="blk-rp-note" data-testid="text-rp-scope">Showing {KIND_META[kind].plural.toLowerCase()} only from this multi-type run. Open the run monitor for all types.{scoped?.sharedCap ? ` The ${scoped.sharedCap.toLocaleString()}-profile cap is shared across all types.` : ''}</p>}
          {!active && TERMINAL[run.status] && <p className={`blk-rp-term t-${run.status}`} data-testid="text-rp-terminal">{TERMINAL[run.status]}{run.error ? ` · ${run.error}` : ''}</p>}
          {preparing && <div className="blk-rp-note" role="status" data-testid="text-rp-preparing">
            <strong>{kinds.length > 1 ? 'Preparing selection across the run’s profile types.' : `Preparing profiles: ${run.preparation!.selected} / up to ${run.preparation!.requested} selected.`}</strong>
            <p>{run.preparation!.message} {active ? 'You can close this page; preparation continues on the server.' : 'Open the run monitor to explicitly resume preparation.'}</p>
          </div>}
          <dl className="blk-rp-stats">
            <div><dt>{cont ? 'Processed total' : 'Processed'}</dt><dd data-testid="text-rp-processed">{cont ? (cap ? `${processed}/${cap}` : processed) : `${chunkDone}/${chunkTotal}`}</dd></div>
            <div title="Processing jobs that finished without a job-level error. Individual platform searches can still be incomplete."><dt>Jobs finished</dt><dd data-testid="text-rp-completed">{cont ? o.completed : cur.completed}</dd></div>
            <div><dt>Failed</dt><dd data-testid="text-rp-failed">{cont ? o.failed : cur.failed}</dd></div>
            <div><dt>Running</dt><dd data-testid="text-rp-running">{cur.running}</dd></div>
            <div><dt>{cont ? 'Queued (chunk)' : 'Queued'}</dt><dd data-testid="text-rp-queued">{cur.queued}</dd></div>
            <div><dt>Updated</dt><dd className="sm" data-testid="text-rp-updated">{new Date(run.updatedAt).toLocaleTimeString()}</dd></div>
          </dl>

          {!preparing && (pct !== null ? (
            <div className="blk-rp-bar-row">
              <div className="blk-rp-bar" role="progressbar" aria-label={barLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}><b style={{ transform: `scaleX(${pct})` }} /></div>
              <span className="inv-mono" data-testid="text-rp-percent">{(pct * 100).toFixed(1)}%</span>
            </div>
          ) : <p className="blk-rp-note" data-testid="text-rp-uncapped">{scoped?.sharedCap ? 'The cap is shared across profile types; there is no separate per-type percentage.' : 'No total cap: overall total unknown, so no overall percentage.'}</p>)}

          {cont && (
            <div className="blk-rp-bar-row chunk">
              <span className="inv-mono">Chunk {chunkDone}/{chunkTotal}{chunkTotal === 0 && active ? ' scanning' : ''}</span>
              <div className="blk-rp-bar" role="progressbar" aria-label={`Current chunk ${chunkDone} of ${chunkTotal}`} aria-valuemin={0} aria-valuemax={chunkTotal || 1} aria-valuenow={chunkDone} aria-valuetext={chunkTotal ? `${chunkDone} of ${chunkTotal} processed in current chunk` : active ? 'Scanning for the next chunk' : 'No current chunk'}><b style={{ transform: `scaleX(${chunkPct})` }} /></div>
            </div>
          )}

          {runningItems.length > 0 && (
            <div className="blk-rp-foot">
              {runningItems.length > 0 && <p data-testid="text-rp-running-names" aria-live="polite"><span>{active ? 'Now:' : 'Last active:'}</span> {runningItems.slice(0, 3).map((item, index) => (
                <span className="blk-rp-profile" key={item.candidate.profileId}>
                  {index > 0 ? '; ' : ''}{item.candidate.profileName}
                  <small data-testid={`text-rp-stage-${item.candidate.profileId}`}> — {item.stage ? STAGE_LABELS[item.stage] : 'In progress'}</small>
                </span>
              ))}{runningItems.length > 3 ? ` +${runningItems.length - 3} more` : ''}</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
});
