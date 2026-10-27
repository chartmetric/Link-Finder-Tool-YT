import { forwardRef } from 'react';
import { ArrowDown, CircleAlert, RefreshCw } from 'lucide-react';
import type { BulkBrandRun } from '@workspace/api-client-react';
import { KIND_META, apiError, isActiveRun, kindCounts, overallCounts, overallKindCounts, runCounts, runKinds } from '@/lib/bulk';

type Props = {
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

export const RunProgress = forwardRef<HTMLElement, Props>(function RunProgress({ runId, run, loading, fetching, error, isError, onRetry, onOpenDetail }, ref) {
  const active = isActiveRun(run);
  const cont = run?.continuous;
  const cur = run ? runCounts(run) : null;
  const o = run ? overallCounts(run) : null;
  const processed = o ? o.completed + o.failed : 0;
  const cap = cont?.profileLimit;
  const chunkDone = cur ? cur.completed + cur.failed : 0;
  const chunkTotal = run?.items.length ?? 0;
  let pct: number | null = null;
  let barLabel = '';
  if (run && !cont) { pct = chunkTotal ? chunkDone / chunkTotal : 0; barLabel = `${chunkDone} of ${chunkTotal} processed`; }
  else if (run && cap) { pct = Math.min(1, processed / cap); barLabel = `${processed} of ${cap} capped profiles processed`; }
  const chunkPct = chunkTotal ? chunkDone / chunkTotal : 0;
  const runningNames = run ? run.items.filter(i => i.status === 'running').map(i => i.candidate.profileName) : [];
  const kinds = run ? runKinds(run) : [];
  const rootId = run?.id ?? runId;

  return (
    <section ref={ref} tabIndex={-1} className="blk-rp" aria-labelledby="blk-rp-title" data-testid="section-run-progress">
      <div className="blk-rp-head">
        <div className="blk-rp-id">
          <span className="inv-kicker">Live run</span>
          <h2 id="blk-rp-title" className="inv-mono" data-testid="text-rp-run-id">{rootId.slice(0, 8)}{cont && <> <span className="blk-tag">continuous</span></>}</h2>
        </div>
        {run && <strong className={`blk-pill r-${run.status}`} data-testid="status-rp">{run.status}</strong>}
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
          {!active && TERMINAL[run.status] && <p className={`blk-rp-term t-${run.status}`} data-testid="text-rp-terminal">{TERMINAL[run.status]}{run.error ? ` · ${run.error}` : ''}</p>}
          <dl className="blk-rp-stats">
            <div><dt>{cont ? 'Processed total' : 'Processed'}</dt><dd data-testid="text-rp-processed">{cont ? (cap ? `${processed}/${cap}` : processed) : `${chunkDone}/${chunkTotal}`}</dd></div>
            <div><dt>Successful</dt><dd data-testid="text-rp-completed">{cont ? o.completed : cur.completed}</dd></div>
            <div><dt>Failed</dt><dd data-testid="text-rp-failed">{cont ? o.failed : cur.failed}</dd></div>
            <div><dt>Running</dt><dd data-testid="text-rp-running">{cur.running}</dd></div>
            <div><dt>{cont ? 'Queued (chunk)' : 'Queued'}</dt><dd data-testid="text-rp-queued">{cur.queued}</dd></div>
            <div><dt>Updated</dt><dd className="sm" data-testid="text-rp-updated">{new Date(run.updatedAt).toLocaleTimeString()}</dd></div>
          </dl>

          {pct !== null ? (
            <div className="blk-rp-bar-row">
              <div className="blk-rp-bar" role="progressbar" aria-label={barLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}><b style={{ transform: `scaleX(${pct})` }} /></div>
              <span className="inv-mono" data-testid="text-rp-percent">{(pct * 100).toFixed(1)}%</span>
            </div>
          ) : <p className="blk-rp-note" data-testid="text-rp-uncapped">No total cap: overall total unknown, so no overall percentage.</p>}

          {cont && (
            <div className="blk-rp-bar-row chunk">
              <span className="inv-mono">Chunk {chunkDone}/{chunkTotal}{chunkTotal === 0 && active ? ' scanning' : ''}</span>
              <div className="blk-rp-bar" role="progressbar" aria-label={`Current chunk ${chunkDone} of ${chunkTotal}`} aria-valuemin={0} aria-valuemax={chunkTotal || 1} aria-valuenow={chunkDone} aria-valuetext={chunkTotal ? `${chunkDone} of ${chunkTotal} processed in current chunk` : active ? 'Scanning for the next chunk' : 'No current chunk'}><b style={{ transform: `scaleX(${chunkPct})` }} /></div>
            </div>
          )}

          {(runningNames.length > 0 || kinds.length > 1) && (
            <div className="blk-rp-foot">
              {runningNames.length > 0 && <p data-testid="text-rp-running-names"><span>Now:</span> {runningNames.slice(0, 3).join(', ')}{runningNames.length > 3 ? ` +${runningNames.length - 3} more` : ''}</p>}
              {kinds.length > 1 && <ul data-testid="list-rp-kinds">{kinds.map(k => { const kc = cont ? overallKindCounts(run, k) : kindCounts(run, k); return (
                <li key={k}><span className={`blk-kind k-${k}`}>{KIND_META[k].code}</span><span className="inv-mono">{kc.completed} ok · {kc.failed} fail · {kc.running} run</span></li>); })}</ul>}
            </div>
          )}
        </>
      )}
    </section>
  );
});
