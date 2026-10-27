import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CircleAlert, Pause, Play, RefreshCw, X } from 'lucide-react';
import { getGetBulkBrandRunQueryKey, getListBulkBrandRunsQueryKey, useGetBulkBrandRun, useResumeBulkBrandRun, useStopBulkBrandRun, type BulkBrandRun } from '@workspace/api-client-react';
import { BrandResult } from './brand-result';
import { BatchArchive } from './batch-archive';
import { KIND_META, apiError, canResume, isActiveRun, kindCounts, overallCounts, overallKindCounts, resumeConfirm, runCounts, runKinds } from '@/lib/bulk';

export function RunDetail({ runId, onClose, onOpenRun }: { runId: string; onClose: () => void; onOpenRun?: (id: string) => void }) {
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
        <div><div className="inv-kicker">03 / Run monitor</div><h2 id="blk-run-title">{run?.archiveOf ? `Chunk ${run.batchNumber ?? '?'} of ${run.archiveOf.slice(0, 8)}` : `Run ${runId.slice(0, 8)}`}{run?.continuous && <> <span className="blk-tag">continuous</span></>}</h2>{run?.archiveOf && onOpenRun && <button type="button" className="blk-backlink" onClick={() => onOpenRun(run.archiveOf!)} data-testid="button-open-root-run"><ArrowLeft size={12} /> Back to continuous run</button>}<p>The queue runs on the server and keeps going if you close this page.</p></div>
        <button type="button" className="inv-retry" style={{ marginTop: 0 }} onClick={onClose} data-testid="button-close-run"><X size={14} /> Close</button>
      </div>

      {run && <p className="inv-mono" data-testid="text-run-workers">{run.workersPerType ?? 1} workers per type · up to {(run.workersPerType ?? 1) * runKinds(run).length} concurrent profile lookups · frozen at start</p>}
      {q.isLoading && <div className="inv-history-card" aria-busy="true">{[0, 1, 2].map(i => <div className="inv-skel" key={i} />)}</div>}
      {q.isError && (
        <div className="inv-history-warn" role="alert" data-testid="status-run-error">
          <CircleAlert size={14} /> {run ? 'Lost contact while polling; showing last known state.' : apiError(q.error, 'This run could not be loaded.')}
          <button type="button" onClick={() => q.refetch()}>Retry</button>
        </div>
      )}

      {run && <RunBody run={run} onOpenRun={onOpenRun} stopping={stop.isPending} resuming={resume.isPending}
        onStop={() => stop.mutate({ runId: run.id })}
        onResume={() => { if (window.confirm(resumeConfirm(run))) resume.mutate({ runId: run.id }); }}
        error={stop.error ? apiError(stop.error, 'Stop failed.') : resume.error ? apiError(resume.error, 'Resume failed.') : ''} />}
    </section>
  );
}

function RunBody({ run, onStop, onResume, stopping, resuming, error, onOpenRun }: { run: BulkBrandRun; onOpenRun?: (id: string) => void; onStop: () => void; onResume: () => void; stopping: boolean; resuming: boolean; error: string }) {
  const active = isActiveRun(run);
  if (run.continuous) return <ContinuousBody run={run} onStop={onStop} onResume={onResume} stopping={stopping} resuming={resuming} error={error} onOpenRun={onOpenRun} />;
  const c = runCounts(run);
  const total = run.items.length || 1;
  return (
    <>
      <div className="blk-run-bar">
        <div className="blk-run-stat lead"><span>Status</span><strong className={`blk-pill r-${run.status}`} data-testid="status-run">{run.status}</strong>{run.stopRequested && active && <em>Stop requested: finishing current profiles</em>}</div>
        <div className="blk-run-stat"><span>Completed</span><strong data-testid="text-run-completed">{c.completed}/{run.items.length}</strong></div>
        <div className="blk-run-stat"><span>Failed</span><strong>{c.failed}</strong></div>
        <div className="blk-run-stat"><span>Running / queued</span><strong>{c.running} / {c.queued}</strong></div>
        <div className="blk-run-stat"><span>Est. cost</span><strong data-testid="text-run-cost">${run.estimatedCostUsd.toFixed(4)}</strong></div>
      </div>
      <div className="blk-progress" role="progressbar" aria-valuemin={0} aria-valuemax={run.items.length} aria-valuenow={c.completed + c.failed} aria-label="Run progress">
        <i className="done" style={{ transform: `scaleX(${c.completed / total})` }} />
        <i className="fail" style={{ transform: `scaleX(${(c.completed + c.failed) / total})` }} />
      </div>
      <ul className="blk-kind-rows" data-testid="list-run-kinds">{runKinds(run).map(k => { const kc = kindCounts(run, k); return (
        <li key={k} data-testid={`row-run-kind-${k}`}><span className={`blk-kind k-${k}`}>{KIND_META[k].plural}</span><span className="inv-mono">{kc.total === 0 ? 'No eligible profiles' : `${kc.completed}/${kc.total} done`}{kc.failed ? ` · ${kc.failed} failed` : ''}{kc.running ? ` · ${kc.running} running` : ''}</span>
          <i className="blk-mini"><b style={{ transform: `scaleX(${kc.total ? (kc.completed + kc.failed) / kc.total : 0})` }} /></i></li>); })}</ul>
      <div className="blk-run-actions">
        <span className="inv-mono" title={`Heartbeat ${new Date(run.heartbeatAt).toLocaleTimeString()} · resume version ${run.resumeVersion}`}>
          Updated {new Date(run.updatedAt).toLocaleTimeString()} · Est. cost excludes provider credits and failed calls
        </span>
        <div>
          {active && <button type="button" className="inv-retry" style={{ marginTop: 0 }} disabled={stopping || run.stopRequested} onClick={onStop} data-testid="button-stop-run"><Pause size={14} /> {run.stopRequested ? 'Stopping after current' : 'Stop after current profiles'}</button>}
          {canResume(run) && <button type="button" className="inv-submit blk-small" disabled={resuming} onClick={onResume} data-testid="button-resume-run">{resuming ? <RefreshCw size={14} className="inv-spin" /> : <Play size={14} />} Resume unfinished</button>}
        </div>
      </div>
      {run.error && <div className="inv-save-warn" role="alert"><CircleAlert size={15} /><span><b>Run error:</b> {run.error}</span></div>}
      {error && <div className="inv-save-warn" role="alert"><CircleAlert size={15} /><span>{error}</span></div>}
      <div className="blk-items">{run.items.map((item, i) => <BrandResult key={item.candidate.profileId} item={item} index={i} />)}</div>
    </>
  );
}

function ContinuousBody({ run, onStop, onResume, stopping, resuming, error, onOpenRun }: { run: BulkBrandRun; onOpenRun?: (id: string) => void; onStop: () => void; onResume: () => void; stopping: boolean; resuming: boolean; error: string }) {
  const cont = run.continuous!;
  const o = overallCounts(run);
  const cur = runCounts(run);
  const active = isActiveRun(run);
  const cap = cont.profileLimit;
  const processed = o.completed + o.failed;
  const capReached = !!cap && processed >= cap;
  return (
    <>
      <div className="blk-run-bar">
        <div className="blk-run-stat lead"><span>Status</span><strong className={`blk-pill r-${run.status}`} data-testid="status-run">{run.status}</strong>{run.stopRequested && active && <em>Stop requested: finishing in-flight profiles, no new work</em>}</div>
        <div className="blk-run-stat"><span>Processed</span><strong data-testid="text-run-completed">{cap ? `${processed}/${cap}` : processed}</strong></div>
        <div className="blk-run-stat"><span>Failed</span><strong>{o.failed}</strong></div>
        <div className="blk-run-stat"><span>Saved chunks</span><strong data-testid="text-run-batches">{cont.batches}</strong></div>
        <div className="blk-run-stat"><span>Est. cost</span><strong data-testid="text-run-cost">${run.estimatedCostUsd.toFixed(4)}</strong></div>
      </div>
      <div className="blk-progress" role="progressbar" aria-label={cap ? "Continuous run progress toward profile cap" : "Current chunk progress"}
        aria-valuemin={0} aria-valuemax={cap ?? (run.items.length || 1)}
        aria-valuenow={Math.min(cap ?? (run.items.length || 1), cap ? processed : cur.completed + cur.failed)}
        aria-valuetext={cap ? `${processed} of ${cap} profiles processed` : run.items.length ? `${cur.completed + cur.failed} of ${run.items.length} profiles processed in current chunk; overall total unknown` : active ? "Scanning for the next chunk; overall total unknown" : "No current chunk"}>
        <i className="done" style={{ transform: `scaleX(${cap ? Math.min(1, o.completed / cap) : cur.completed / (run.items.length || 1)})` }} />
        <i className="fail" style={{ transform: `scaleX(${cap ? Math.min(1, processed / cap) : (cur.completed + cur.failed) / (run.items.length || 1)})` }} />
      </div>
      <div className="blk-cont-strip" data-testid="text-continuous-summary">
        {capReached ? <span data-testid="text-cap-reached"><b>Profile cap reached</b> ({processed} of {cap} profiles)</span> : cap ? <span><b>{processed} of {cap}</b> capped profiles processed</span> : <span><b>Total unknown</b> while the catalog still has remaining profiles</span>}
        <span>Current chunk: <b>{cur.completed + cur.failed}/{run.items.length}</b>{run.items.length === 0 ? (active ? ' (scanning)' : '') : ''}</span>
        <span><b>{cur.running}</b> running · <b>{cur.queued}</b> queued in current chunk</span>
        <span>All earlier results are saved</span>
      </div>
      <ul className="blk-kind-rows" data-testid="list-run-kinds">{runKinds(run).map(k => { const kc = overallKindCounts(run, k); return (
        <li key={k} data-testid={`row-run-kind-${k}`}><span className={`blk-kind k-${k}`}>{KIND_META[k].plural}</span><span className="inv-mono">{kc.completed} done{kc.failed ? ` · ${kc.failed} failed` : ''}{kc.running ? ` · ${kc.running} running` : ''} · {kc.exhausted ? 'none remaining' : capReached ? 'stopped at cap' : 'more remaining'}</span></li>); })}</ul>
      <div className="blk-run-actions">
        <span className="inv-mono">Updated {new Date(run.updatedAt).toLocaleTimeString()} · {cap ? `Total cap ${cap} profiles` : 'No total cap'} · Est. cost is cumulative and excludes provider credits and failed calls</span>
        <div>
          {active && <button type="button" className="inv-retry" style={{ marginTop: 0 }} disabled={stopping || run.stopRequested} onClick={onStop} data-testid="button-stop-run"><Pause size={14} /> {run.stopRequested ? 'Stopping' : 'Stop continuous run'}</button>}
          {canResume(run) && <button type="button" className="inv-submit blk-small" disabled={resuming} onClick={onResume} data-testid="button-resume-run">{resuming ? <RefreshCw size={14} className="inv-spin" /> : <Play size={14} />} Resume continuous run</button>}
        </div>
      </div>
      {run.status === 'interrupted' && <div className="inv-save-warn" role="status"><CircleAlert size={15} /><span>Paused by a server restart. Nothing runs until someone resumes it.</span></div>}
      {run.error && <div className="inv-save-warn" role="alert"><CircleAlert size={15} /><span><b>Run error:</b> {run.error}</span></div>}
      {error && <div className="inv-save-warn" role="alert"><CircleAlert size={15} /><span>{error}</span></div>}
      {onOpenRun && <BatchArchive rootId={run.id} total={cont.batches} onOpenRun={onOpenRun} />}
      <div className="blk-items" style={{ marginTop: 10 }}>{run.items.map((item, i) => <BrandResult key={item.candidate.profileId} item={item} index={i} />)}</div>
    </>
  );
}
