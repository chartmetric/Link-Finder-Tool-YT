import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CircleAlert, Infinity as InfinityIcon } from 'lucide-react';
import { getGetBulkBrandRunQueryKey, getListBulkBrandRunsQueryKey, useStartBulkBrandRun } from '@workspace/api-client-react';
import { KIND_META, apiError, continuousConfirm, parseCap, type ProfileKind } from '@/lib/bulk';

export function AutoLauncher({ kind, blocked, onRun }: { kind: ProfileKind; blocked: boolean; onRun: (id: string) => void }) {
  const qc = useQueryClient();
  const m = KIND_META[kind];
  const [limit, setLimit] = useState(25);
  const [workers, setWorkers] = useState(1);
  const [continuous, setContinuous] = useState(false);
  const [capRaw, setCapRaw] = useState('');
  const cap = parseCap(capRaw);
  const pending = useRef<{ id: string; key: string } | null>(null);
  const start = useStartBulkBrandRun();
  useEffect(() => { setContinuous(false); setCapRaw(''); start.reset(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const validWorkers = Number.isSafeInteger(workers) && workers >= 1 && workers <= 20;
  const canStart = !start.isPending && !blocked && validWorkers && Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000 && !(continuous && cap === undefined);
  const submit = () => {
    if (!canStart) return;
    const profileLimit = continuous && typeof cap === 'number' ? cap : undefined;
    if (continuous && !window.confirm(continuousConfirm(profileLimit ?? null))) return;
    const scopes = [{ profileType: kind, limit }];
    const key = JSON.stringify({ scopes, continuous, profileLimit, workersPerType: workers });
    if (!pending.current || pending.current.key !== key) pending.current = { id: crypto.randomUUID(), key };
    start.mutate({ data: { requestId: pending.current.id, scopes, continuous, workersPerType: workers, ...(profileLimit !== undefined ? { profileLimit } : {}) } }, {
      onSuccess: run => {
        pending.current = null;
        qc.setQueryData(getGetBulkBrandRunQueryKey(run.id), run);
        qc.invalidateQueries({ queryKey: getListBulkBrandRunsQueryKey() });
        onRun(run.id);
      },
    });
  };

  return (
    <section className="inv-panel blk-auto" aria-labelledby="blk-auto-title" data-testid="section-auto-launch">
      <div className="blk-auto-main">
        <div><div className="inv-kicker">Automatic / {m.plural.toLowerCase()}</div><h2 id="blk-auto-title">Process remaining {m.plural.toLowerCase()} without picking</h2></div>
        <div className="blk-auto-fields">
          <div className="blk-auto-field">Profiles to process<strong data-testid="text-auto-scope">Remaining eligible profiles</strong></div>
          <div className="blk-auto-field">Mode
            <div className="blk-mode" role="group" aria-label="Run mode">
              <button type="button" className={!continuous ? 'on' : ''} aria-pressed={!continuous} onClick={() => setContinuous(false)} data-testid="button-auto-mode-once">One chunk</button>
              <button type="button" className={continuous ? 'on' : ''} aria-pressed={continuous} onClick={() => setContinuous(true)} data-testid="button-auto-mode-continuous"><InfinityIcon size={12} style={{ display: 'inline', verticalAlign: '-2px' }} /> Continuous</button>
            </div>
          </div>
          <label className="blk-auto-field">{continuous ? 'Chunk size' : 'Profiles this run'}
            <input type="number" min={1} max={1000} value={limit} onChange={e => setLimit(Math.max(1, Math.min(1000, Math.round(Number(e.target.value)) || 1)))} data-testid="input-auto-limit" />
          </label>
          {continuous && <label className="blk-auto-field">Optional total profile cap
            <input type="text" inputMode="numeric" placeholder="All remaining" value={capRaw} onChange={e => setCapRaw(e.target.value)} aria-invalid={cap === undefined} data-testid="input-auto-cap" />
          </label>}
        </div>
        <label className="blk-worker-field">Parallel workers (1–20)
          <input type="number" min={1} max={20} value={workers} onChange={e => setWorkers(Number(e.target.value))} data-testid="input-auto-workers" />
        </label>
        {!validWorkers && <p className="inv-form-error" role="alert">Workers must be a whole number from 1 to 20.</p>}
        <p className="blk-auto-note">Picks the next eligible {m.plural.toLowerCase()} automatically. Skips prior bulk attempts and profiles with no linked account. Source catalog is read-only. Up to {validWorkers ? workers : '—'} concurrent lookups. Higher counts spend credits faster and may hit provider rate limits. Worker settings are frozen when the run starts.</p>
        {continuous && <p className="blk-auto-note warn" data-testid="text-auto-continuous-note">{cap === undefined ? 'Total cap must be a whole number from 1 to 4294967295, or blank.' : typeof cap === 'number' ? `${limit} is the chunk size. At most ${cap} distinct profiles (failures count), then the run completes. Explicit retries may add charges.` : `${limit} is the chunk size, not a total cap. No total cap: continues through every remaining ${m.label.toLowerCase()} until exhausted or stopped, saving each chunk.`}</p>}
      </div>
      <div className="blk-launch-side">
        <div className="blk-paid"><CircleAlert size={15} /><p><b>Paid service.</b> {continuous ? typeof cap === 'number' ? `Continuous run capped at ${cap} distinct profiles; provider cost and explicit retry charges may vary. Keeps running after the browser closes; a server restart pauses it until resumed.` : 'Continuous runs have no total spending cap and keep running after the browser closes. A server restart pauses the run until it is resumed.' : 'Each profile calls paid discovery and verification providers.'}</p></div>
        <button type="button" className="inv-submit" disabled={!canStart} onClick={submit} data-testid="button-auto-start">
          {start.isPending ? 'Starting run' : continuous ? `Run all remaining ${m.plural.toLowerCase()}` : `Start next ${limit} ${(limit === 1 ? m.label : m.plural).toLowerCase()}`} <ArrowRight size={16} />
        </button>
        {blocked && !start.isPending && <p className="blk-link" style={{ textDecoration: 'none' }}>A run is active or another action is in progress.</p>}
        {start.isError && <p className="inv-form-error" role="alert" data-testid="text-auto-error">{apiError(start.error, 'The run could not be started.')} Retrying the same settings is safe.</p>}
      </div>
    </section>
  );
}
