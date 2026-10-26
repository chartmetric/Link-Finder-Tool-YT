import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, Pause, Play, RefreshCw, X } from 'lucide-react';
import { getGetBulkBrandRunQueryKey, getListBulkBrandRunsQueryKey, useGetBulkBrandRun, useResumeBulkBrandRun, useStopBulkBrandRun, type BulkBrandRun } from '@workspace/api-client-react';
import { BrandResult } from './brand-result';
import { apiError, canResume, isActiveRun, runCounts } from '@/lib/bulk';

export function RunDetail({ runId, onClose }: { runId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useGetBulkBrandRun(runId, {
    query: {
      queryKey: getGetBulkBrandRunQueryKey(runId),
      enabled: !!runId,
      refetchInterval: query => (isActiveRun(query.state.data) ? 3000 : false),
    },
  });
  const sync = (run: BulkBrandRun) => {
    qc.setQueryData(getGetBulkBrandRunQueryKey(run.id), run);
    qc.invalidateQueries({ queryKey: getListBulkBrandRunsQueryKey() });
  };
  const stop = useStopBulkBrandRun({ mutation: { onSuccess: sync } });
  const resume = useResumeBulkBrandRun({ mutation: { onSuccess: sync } });
  const run = q.data;

  return (
    <section className="inv-panel blk-run" aria-labelledby="blk-run-title" aria-live="polite" data-testid="section-bulk-run">
      <div className="inv-panel-head">
        <div><div className="inv-kicker">03 / Run monitor</div><h2 id="blk-run-title">Run {runId.slice(0, 8)}</h2><p>The queue runs on the server and keeps going if you close this page.</p></div>
        <button type="button" className="inv-retry" style={{ marginTop: 0 }} onClick={onClose} data-testid="button-close-run"><X size={14} /> Close</button>
      </div>

      {q.isLoading && <div className="inv-history-card" aria-busy="true">{[0, 1, 2].map(i => <div className="inv-skel" key={i} />)}</div>}
      {q.isError && (
        <div className="inv-history-warn" role="alert" data-testid="status-run-error">
          <CircleAlert size={14} /> {run ? 'Lost contact while polling; showing last known state.' : apiError(q.error, 'This run could not be loaded.')}
          <button type="button" onClick={() => q.refetch()}>Retry</button>
        </div>
      )}

      {run && <RunBody run={run} stopping={stop.isPending} resuming={resume.isPending}
        onStop={() => stop.mutate({ runId: run.id })}
        onResume={() => { if (window.confirm('Resume retries queued, failed and interrupted brands (not completed ones) and may incur more paid provider requests. Continue?')) resume.mutate({ runId: run.id }); }}
        error={stop.error ? apiError(stop.error, 'Stop failed.') : resume.error ? apiError(resume.error, 'Resume failed.') : ''} />}
    </section>
  );
}

function RunBody({ run, onStop, onResume, stopping, resuming, error }: { run: BulkBrandRun; onStop: () => void; onResume: () => void; stopping: boolean; resuming: boolean; error: string }) {
  const c = runCounts(run);
  const total = run.items.length || 1;
  const active = isActiveRun(run);
  return (
    <>
      <div className="blk-run-bar">
        <div className="blk-run-stat lead"><span>Status</span><strong className={`blk-pill r-${run.status}`} data-testid="status-run">{run.status}</strong>{run.stopRequested && run.status !== 'stopped' && <em>Stop requested: finishing current brand</em>}</div>
        <div className="blk-run-stat"><span>Completed</span><strong data-testid="text-run-completed">{c.completed}/{run.items.length}</strong></div>
        <div className="blk-run-stat"><span>Failed</span><strong>{c.failed}</strong></div>
        <div className="blk-run-stat"><span>Queued</span><strong>{c.queued + c.running}</strong></div>
        <div className="blk-run-stat"><span>Est. cost</span><strong data-testid="text-run-cost">${run.estimatedCostUsd.toFixed(4)}</strong></div>
      </div>
      <div className="blk-progress" role="progressbar" aria-valuemin={0} aria-valuemax={run.items.length} aria-valuenow={c.completed + c.failed} aria-label="Run progress">
        <i className="done" style={{ transform: `scaleX(${c.completed / total})` }} />
        <i className="fail" style={{ transform: `scaleX(${(c.completed + c.failed) / total})` }} />
      </div>
      <div className="blk-run-actions">
        <span className="inv-mono" title={`Heartbeat ${new Date(run.heartbeatAt).toLocaleTimeString()} · resume version ${run.resumeVersion}`}>
          Updated {new Date(run.updatedAt).toLocaleTimeString()} · Est. cost excludes provider credits and failed calls
        </span>
        <div>
          {active && <button type="button" className="inv-retry" style={{ marginTop: 0 }} disabled={stopping || run.stopRequested} onClick={onStop} data-testid="button-stop-run"><Pause size={14} /> {run.stopRequested ? 'Stopping after current' : 'Stop after current brand'}</button>}
          {canResume(run) && <button type="button" className="inv-submit blk-small" disabled={resuming} onClick={onResume} data-testid="button-resume-run">{resuming ? <RefreshCw size={14} className="inv-spin" /> : <Play size={14} />} Resume unfinished</button>}
        </div>
      </div>
      {run.error && <div className="inv-save-warn" role="alert"><CircleAlert size={15} /><span><b>Run error:</b> {run.error}</span></div>}
      {error && <div className="inv-save-warn" role="alert"><CircleAlert size={15} /><span>{error}</span></div>}
      <div className="blk-items">{run.items.map((item, i) => <BrandResult key={item.candidate.profileId} item={item} index={i} />)}</div>
    </>
  );
}
