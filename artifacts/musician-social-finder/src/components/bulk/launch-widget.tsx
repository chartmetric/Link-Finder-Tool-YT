import { useEffect, useRef, useState } from 'react';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, CircleAlert, Layers, Pause, Play, RefreshCw, Zap } from 'lucide-react';
import { getGetBulkBrandRunQueryKey, getListBulkBrandRunsQueryKey, useGetBulkBrandRun, useResumeBulkBrandRun, useStartBulkBrandRun, useStopBulkBrandRun, type BulkBrandRun } from '@workspace/api-client-react';
import { KIND_META, PROFILE_KINDS, WIDGET_KEY, apiError, canResume, isActiveRun, kindCounts, readStorage, runCounts, runKinds, writeStorage, type ProfileKind } from '@/lib/bulk';

const MAX_TOTAL = 25;
const DEFAULT_COUNT = 5;
type WidgetState = { open: boolean; on: Record<ProfileKind, boolean>; counts: Record<ProfileKind, number> };
const initial: WidgetState = { open: false, on: { brand: true, creator: false, artist: false }, counts: { brand: DEFAULT_COUNT, creator: DEFAULT_COUNT, artist: DEFAULT_COUNT } };

export function LaunchWidget({ runId, onRun }: { runId: string | null; onRun: (id: string) => void }) {
  const qc = useQueryClient();
  const [st, setSt] = useState<WidgetState>(() => ({ ...initial, ...readStorage<Partial<WidgetState>>(WIDGET_KEY, {}) }));
  const [ack, setAck] = useState(false);
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
  const run = runId ? q.data : undefined;
  const active = isActiveRun(run);

  const scopes = PROFILE_KINDS.filter(k => st.on[k]).map(k => ({ profileType: k, limit: st.counts[k] }));
  const total = scopes.reduce((n, s) => n + s.limit, 0);
  const over = total > MAX_TOTAL;
  const canStart = scopes.length > 0 && !over && ack && !busy && !active && !(runId && q.isLoading);

  const setCount = (k: ProfileKind, v: number) => setSt(s => ({ ...s, counts: { ...s.counts, [k]: Math.max(1, Math.min(MAX_TOTAL, Math.round(v) || 1)) } }));
  const submit = () => {
    if (!canStart) return;
    const key = JSON.stringify(scopes);
    if (!pending.current || pending.current.key !== key) pending.current = { id: crypto.randomUUID(), key };
    start.mutate({ data: { requestId: pending.current.id, scopes } }, {
      onSuccess: r => { pending.current = null; sync(r); onRun(r.id); setAck(false); },
    });
  };

  const c = run ? runCounts(run) : null;
  return (
    <aside className={`blk-widget${st.open ? ' open' : ''}`} aria-label="Cross-type launcher" data-testid="widget-launch">
      <button type="button" className="blk-widget-bar" aria-expanded={st.open} onClick={() => setSt(s => ({ ...s, open: !s.open }))} data-testid="button-toggle-widget">
        <Layers size={15} />
        <span className="blk-widget-title">Multi-type run</span>
        {run && c ? <span className={`blk-pill r-${run.status}`} data-testid="status-widget-run">{run.status} · {c.completed + c.failed}/{run.items.length}</span>
          : <span className="inv-mono blk-widget-sum">{scopes.length} {scopes.length === 1 ? 'type' : 'types'} · {total}</span>}
        {st.open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
      </button>

      {st.open && (
        <div className="blk-widget-body">
          {run && (
            <div className="blk-widget-run" data-testid="section-widget-run">
              <div className="blk-widget-runhead"><span className="inv-mono">Run {run.id.slice(0, 8)}</span><span className="inv-mono">${run.estimatedCostUsd.toFixed(4)}</span></div>
              <ul className="blk-kind-rows">{runKinds(run).map(k => { const kc = kindCounts(run, k); return (
                <li key={k} data-testid={`widget-kind-${k}`}><span className={`blk-kind k-${k}`}>{KIND_META[k].plural}</span><span className="inv-mono">{kc.total === 0 ? 'No eligible profiles' : `${kc.completed}/${kc.total}`}{kc.failed ? ` · ${kc.failed} failed` : ''}{kc.running ? ` · ${kc.running} live` : ''}</span>
                  <i className="blk-mini"><b style={{ transform: `scaleX(${kc.total ? (kc.completed + kc.failed) / kc.total : 0})` }} /></i></li>); })}</ul>
              <div className="blk-widget-ctl">
                {active && <button type="button" className="inv-retry" style={{ marginTop: 0 }} disabled={stop.isPending || run.stopRequested} onClick={() => stop.mutate({ runId: run.id })} data-testid="button-widget-stop"><Pause size={13} /> {run.stopRequested ? 'Stopping' : 'Stop all'}</button>}
                {canResume(run) && <button type="button" className="inv-retry" style={{ marginTop: 0 }} disabled={resume.isPending} onClick={() => { if (window.confirm('Resume retries queued, failed and interrupted profiles (not completed ones) and may incur more paid provider requests. Continue?')) resume.mutate({ runId: run.id }); }} data-testid="button-widget-resume">{resume.isPending ? <RefreshCw size={13} className="inv-spin" /> : <Play size={13} />} Resume unfinished</button>}
              </div>
              {(stop.error || resume.error) && <p className="inv-form-error" role="alert">{stop.error ? apiError(stop.error, 'Stop failed.') : apiError(resume.error, 'Resume failed.')}</p>}
            </div>
          )}

          <fieldset className="blk-widget-types">
            <legend className="inv-mono">Auto-pick linked profiles per type</legend>
            {PROFILE_KINDS.map(k => (
              <div key={k} className={`blk-widget-type${st.on[k] ? ' on' : ''}`}>
                <label><input type="checkbox" checked={st.on[k]} onChange={e => setSt(s => ({ ...s, on: { ...s.on, [k]: e.target.checked } }))} data-testid={`checkbox-widget-${k}`} /> {KIND_META[k].plural}</label>
                <input type="number" min={1} max={MAX_TOTAL} value={st.counts[k]} disabled={!st.on[k]} aria-label={`${KIND_META[k].plural} to look up`} onChange={e => setCount(k, Number(e.target.value))} data-testid={`input-widget-count-${k}`} />
              </div>
            ))}
          </fieldset>
          <p className={`inv-mono blk-widget-total${over ? ' bad' : ''}`} data-testid="text-widget-total">{total} of {MAX_TOTAL} max per run{over ? ' · reduce counts' : ''}</p>
          <div className="blk-paid"><CircleAlert size={14} /><p><b>Paid service.</b> One lookup per type runs at a time. Each profile calls paid providers.</p></div>
          <label className="blk-ack"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} data-testid="checkbox-widget-ack" /> I understand this run makes paid requests.</label>
          <button type="button" className="inv-submit blk-small" disabled={!canStart} onClick={submit} data-testid="button-widget-start">
            <Zap size={14} /> {start.isPending ? 'Starting run' : `Start ${total} across ${scopes.length} ${scopes.length === 1 ? 'type' : 'types'}`}
          </button>
          {start.isError && <p className="inv-form-error" role="alert" data-testid="text-widget-error">{apiError(start.error, 'The run could not be started.')} Retrying the same counts is safe.</p>}
        </div>
      )}
    </aside>
  );
}
