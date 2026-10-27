import { useEffect, useRef, useState } from 'react';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, CircleAlert, Layers, Pause, Play, RefreshCw, Zap } from 'lucide-react';
import { getGetBulkBrandRunQueryKey, getListBulkBrandRunsQueryKey, useGetBulkBrandRun, useResumeBulkBrandRun, useStartBulkBrandRun, useStopBulkBrandRun, type BulkBrandRun } from '@workspace/api-client-react';
import { continuousConfirm, parseCap, KIND_META, PROFILE_KINDS, WIDGET_KEY, apiError, canResume, isActiveRun, overallCounts, overallKindCounts, readStorage, resumeConfirm, runKinds, writeStorage, type ProfileKind } from '@/lib/bulk';

const MAX_TOTAL = 1000;
const DEFAULT_COUNT = 5;
type WidgetState = { open: boolean; on: Record<ProfileKind, boolean>; counts: Record<ProfileKind, number> };
const initial: WidgetState = { open: false, on: { brand: true, creator: false, artist: false }, counts: { brand: DEFAULT_COUNT, creator: DEFAULT_COUNT, artist: DEFAULT_COUNT } };

export function LaunchWidget({ runId, onRun }: { runId: string | null; onRun: (id: string) => void }) {
  const qc = useQueryClient();
  const [st, setSt] = useState<WidgetState>(() => ({ ...initial, ...readStorage<Partial<WidgetState>>(WIDGET_KEY, {}) }));
  const [ack, setAck] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [workersRaw, setWorkersRaw] = useState('1');
  const workers = Number(workersRaw);
  const [capRaw, setCapRaw] = useState('');
  const cap = parseCap(capRaw);
  const pending = useRef<{ id: string; key: string } | null>(null);
  useEffect(() => { writeStorage(WIDGET_KEY, st); }, [st]);

  const start = useStartBulkBrandRun();
  const busy = useIsMutating() > 0;
  const q = useGetBulkBrandRun(runId ?? '', {
    query: { queryKey: getGetBulkBrandRunQueryKey(runId ?? ''), enabled: !!runId, refetchInterval: query => (isActiveRun(query.state.data) ? 3000 : false) },
  });
  const sync = (run: BulkBrandRun) => { qc.setQueryData(getGetBulkBrandRunQueryKey(run.id), run); qc.invalidateQueries({ queryKey: getListBulkBrandRunsQueryKey() }); };
  const stop = useStopBulkBrandRun({ mutation: { onSuccess: sync } });
  const resume = useResumeBulkBrandRun({ mutation: { onSuccess: sync } });
  // When an archived chunk is open, follow its continuous root for progress and controls.
  const rootId = runId ? q.data?.archiveOf : undefined;
  const rq = useGetBulkBrandRun(rootId ?? '', {
    query: { queryKey: getGetBulkBrandRunQueryKey(rootId ?? ''), enabled: !!rootId, refetchInterval: query => (isActiveRun(query.state.data) ? 3000 : false) },
  });
  const run = !runId ? undefined : rootId ? rq.data : q.data;
  const active = isActiveRun(run);

  const scopes = PROFILE_KINDS.filter(k => st.on[k]).map(k => ({ profileType: k, limit: st.counts[k] }));
  const total = scopes.reduce((n, s) => n + s.limit, 0);
  const over = total > MAX_TOTAL;
  const validWorkers = Number.isSafeInteger(workers) && workers >= 1 && workers <= 20;
  const canStart = validWorkers && !(continuous && cap === undefined) && scopes.length > 0 && !over && ack && !busy && !active && !(runId && q.isLoading) && !(rootId && rq.isLoading);

  const setCount = (k: ProfileKind, v: number) => setSt(s => ({ ...s, counts: { ...s.counts, [k]: Math.max(1, Math.min(MAX_TOTAL, Math.round(v) || 1)) } }));
  const submit = () => {
    if (!canStart) return;
    const profileLimit = continuous && typeof cap === 'number' ? cap : undefined;
    if (continuous && !window.confirm(continuousConfirm(profileLimit ?? null))) return;
    const key = JSON.stringify({ scopes, continuous, profileLimit, workersPerType: workers });
    if (!pending.current || pending.current.key !== key) pending.current = { id: crypto.randomUUID(), key };
    start.mutate({ data: { requestId: pending.current.id, scopes, continuous, workersPerType: workers, ...(profileLimit !== undefined ? { profileLimit } : {}) } }, {
      onSuccess: r => { pending.current = null; sync(r); onRun(r.id); setAck(false); },
    });
  };

  const c = run ? overallCounts(run) : null;
  return (
    <aside className={`blk-widget${st.open ? ' open' : ''}`} aria-label="Cross-type launcher" data-testid="widget-launch">
      <button type="button" className="blk-widget-bar" aria-expanded={st.open} onClick={() => setSt(s => ({ ...s, open: !s.open }))} data-testid="button-toggle-widget">
        <Layers size={15} />
        <span className="blk-widget-title">Multi-type run</span>
        {run && c ? <span className={`blk-pill r-${run.status}`} data-testid="status-widget-run">{run.status} · {run.continuous ? `${c.completed + c.failed} processed` : `${c.completed + c.failed}/${run.items.length}`}</span>
          : <span className="inv-mono blk-widget-sum">{scopes.length} {scopes.length === 1 ? 'type' : 'types'} · {total}</span>}
        {st.open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
      </button>

      {st.open && (
        <div className="blk-widget-body">
          {run && (
            <div className="blk-widget-run" data-testid="section-widget-run">
              <div className="blk-widget-runhead"><span className="inv-mono">Run {run.id.slice(0, 8)} · {run.workersPerType ?? 1} workers/type</span><span className="inv-mono">${run.estimatedCostUsd.toFixed(4)}</span></div>
              <ul className="blk-kind-rows">{runKinds(run).map(k => { const kc = overallKindCounts(run, k); return (
                <li key={k} data-testid={`widget-kind-${k}`}><span className={`blk-kind k-${k}`}>{KIND_META[k].plural}</span><span className="inv-mono">{run.continuous ? `${kc.completed} done${kc.exhausted ? ' · none left' : ''}` : kc.total === 0 ? 'No eligible profiles' : `${kc.completed}/${kc.total}`}{kc.failed ? ` · ${kc.failed} failed` : ''}{kc.running ? ` · ${kc.running} live` : ''}</span>
                  {!run.continuous && <i className="blk-mini"><b style={{ transform: `scaleX(${kc.total ? (kc.completed + kc.failed) / kc.total : 0})` }} /></i>}</li>); })}</ul>
              <div className="blk-widget-ctl">
                {active && <button type="button" className="inv-retry" style={{ marginTop: 0 }} disabled={stop.isPending || run.stopRequested} onClick={() => stop.mutate({ runId: run.id })} data-testid="button-widget-stop"><Pause size={13} /> {run.stopRequested ? 'Stopping' : 'Stop all'}</button>}
                {canResume(run) && <button type="button" className="inv-retry" style={{ marginTop: 0 }} disabled={resume.isPending} onClick={() => { if (window.confirm(resumeConfirm(run))) resume.mutate({ runId: run.id }); }} data-testid="button-widget-resume">{resume.isPending ? <RefreshCw size={13} className="inv-spin" /> : <Play size={13} />} Resume unfinished</button>}
              </div>
              {(stop.error || resume.error) && <p className="inv-form-error" role="alert">{stop.error ? apiError(stop.error, 'Stop failed.') : apiError(resume.error, 'Resume failed.')}</p>}
            </div>
          )}

          <fieldset className="blk-widget-types">
            <legend className="inv-mono">Profiles to process: remaining eligible, per type</legend>
            {PROFILE_KINDS.map(k => (
              <div key={k} className={`blk-widget-type${st.on[k] ? ' on' : ''}`}>
                <label><input type="checkbox" checked={st.on[k]} onChange={e => setSt(s => ({ ...s, on: { ...s.on, [k]: e.target.checked } }))} data-testid={`checkbox-widget-${k}`} /> {KIND_META[k].plural}</label>
                <input type="number" min={1} max={MAX_TOTAL} value={st.counts[k]} disabled={!st.on[k]} aria-label={`${KIND_META[k].plural} to look up`} onChange={e => setCount(k, Number(e.target.value))} data-testid={`input-widget-count-${k}`} />
              </div>
            ))}
          </fieldset>
          <p className={`inv-mono blk-widget-total${over ? ' bad' : ''}`} data-testid="text-widget-total">{total} of {MAX_TOTAL} max {continuous ? 'per chunk' : 'per run'}{over ? ' · reduce counts' : ''}</p>
          <label className="blk-cont"><input type="checkbox" checked={continuous} onChange={e => { setContinuous(e.target.checked); setAck(false); }} data-testid="checkbox-widget-continuous" /><div>Run continuously<span>Counts become chunk sizes, not a cap. Keeps processing all remaining profiles until exhausted or stopped, with no total spending cap, even after the browser closes.</span></div></label>
          {continuous && <div className={`blk-widget-type on`}><label htmlFor="widget-cap">Optional total profile cap</label><input id="widget-cap" type="text" inputMode="numeric" placeholder="All" value={capRaw} onChange={e => { setCapRaw(e.target.value); setAck(false); }} aria-invalid={cap === undefined} style={{ width: 90, border: '1px solid #cbd6e1', borderRadius: 6, padding: '5px 7px', font: '700 12px var(--app-font-mono)' }} data-testid="input-widget-cap" /></div>}
          {continuous && <p className={`inv-mono blk-widget-total${cap === undefined ? ' bad' : ''}`} data-testid="text-widget-cap">{cap === undefined ? 'Cap must be 1 to 4294967295 or blank' : typeof cap === 'number' ? `At most ${cap} distinct profiles; failures count. Explicit retries may add charges.` : 'Blank: all remaining, no total cap'}</p>}
          <label className="blk-worker-field">Workers per type (1–20)
            <input type="number" min={1} max={20} step={1} value={workersRaw} onChange={e => { setWorkersRaw(e.target.value); setAck(false); }} aria-invalid={!validWorkers} data-testid="input-widget-workers" />
          </label>
          {!validWorkers && <p className="inv-form-error" role="alert">Workers must be a whole number from 1 to 20.</p>}
          <div className="blk-paid"><CircleAlert size={14} /><p><b>Paid service.</b> Up to {validWorkers ? workers * scopes.length : '—'} concurrent profile lookups across selected types. Higher counts spend credits faster and may hit provider rate limits. Settings apply to new runs only.</p></div>
          <label className="blk-ack"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} data-testid="checkbox-widget-ack" /> I understand this run makes paid requests.</label>
          <button type="button" className="inv-submit blk-small" disabled={!canStart} onClick={submit} data-testid="button-widget-start">
            <Zap size={14} /> {start.isPending ? 'Starting run' : continuous ? `Run all remaining · ${scopes.length} ${scopes.length === 1 ? 'type' : 'types'}` : `Start ${total} across ${scopes.length} ${scopes.length === 1 ? 'type' : 'types'}`}
          </button>
          {start.isError && <p className="inv-form-error" role="alert" data-testid="text-widget-error">{apiError(start.error, 'The run could not be started.')} Retrying the same counts is safe.</p>}
        </div>
      )}
    </aside>
  );
}
