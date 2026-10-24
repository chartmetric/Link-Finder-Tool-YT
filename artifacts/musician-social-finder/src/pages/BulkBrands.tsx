import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowLeft, ArrowRight, CircleAlert, X } from 'lucide-react';
import { getGetBulkBrandRunQueryKey, getListBulkBrandRunsQueryKey, useStartBulkBrandRun, type BulkBrandCandidate } from '@workspace/api-client-react';
import { CandidatePicker } from '@/components/bulk/candidate-picker';
import { RunList } from '@/components/bulk/run-list';
import { RunDetail } from '@/components/bulk/run-detail';
import { LAST_RUN_KEY, SELECTION_KEY, apiError, readStorage, writeStorage } from '@/lib/bulk';
import '@/styles/bulk.css';

export default function BulkBrands() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState(() => new Map<number, BulkBrandCandidate>(readStorage<BulkBrandCandidate[]>(SELECTION_KEY, []).map(c => [c.profileId, c])));
  const [maxBatch, setMaxBatch] = useState(25);
  const [runId, setRunId] = useState<string | null>(() => readStorage<string | null>(LAST_RUN_KEY, null));
  const [ack, setAck] = useState(false);
  const pendingRequest = useRef<{ id: string; key: string } | null>(null);
  const start = useStartBulkBrandRun();

  useEffect(() => { writeStorage(SELECTION_KEY, [...selected.values()]); }, [selected]);
  useEffect(() => { writeStorage(LAST_RUN_KEY, runId); }, [runId]);
  useEffect(() => { document.title = 'Bulk brand finder · Profile Handles Online'; }, []);

  const toggle = (c: BulkBrandCandidate) => setSelected(prev => {
    const next = new Map(prev);
    if (next.has(c.profileId)) next.delete(c.profileId); else if (next.size < maxBatch) next.set(c.profileId, c);
    return next;
  });
  const setMany = (cs: BulkBrandCandidate[], on: boolean) => setSelected(prev => {
    const next = new Map(prev);
    for (const c of cs) { if (!on) next.delete(c.profileId); else if (next.size < maxBatch) next.set(c.profileId, c); }
    return next;
  });

  const ids = [...selected.keys()].sort((a, b) => a - b);
  const submit = () => {
    if (start.isPending || ids.length === 0 || !ack) return;
    const key = ids.join(',');
    // Same selection retried after a failure reuses its requestId so the server can dedupe.
    if (!pendingRequest.current || pendingRequest.current.key !== key) pendingRequest.current = { id: crypto.randomUUID(), key };
    start.mutate({ data: { requestId: pendingRequest.current.id, profileIds: ids } }, {
      onSuccess: run => {
        pendingRequest.current = null;
        qc.setQueryData(getGetBulkBrandRunQueryKey(run.id), run);
        qc.invalidateQueries({ queryKey: getListBulkBrandRunsQueryKey() });
        setRunId(run.id);
        setSelected(new Map());
        setAck(false);
      },
    });
  };

  return (
    <div className="investigation">
      <header className="inv-nav">
        <div className="inv-wrap inv-nav-inner">
          <Link href="/" className="inv-brand" aria-label="Profile Handles Online, back to single investigation">
            <span className="inv-brand-mark"><Activity size={19} strokeWidth={2.5} /></span>
            <span className="inv-brand-name">Profile Handles Online<span className="inv-brand-caption inv-mono">Bulk brand finder</span></span>
          </Link>
          <Link href="/" className="inv-back" data-testid="link-single-investigation"><ArrowLeft size={14} /> Single investigation</Link>
        </div>
      </header>

      <main className="inv-wrap inv-workspace">
        <div className="inv-section-head">
          <div><div className="inv-kicker">Bulk link finder / brands</div><h2>Fill gaps for single-account brands</h2></div>
          <p className="inv-section-note">Results are suggestions for human review. No approvals or catalog writes happen here.</p>
        </div>

        <CandidatePicker selected={selected} onToggle={toggle} onSetMany={setMany} maxBatch={maxBatch} onMaxBatch={setMaxBatch} />

        <section className="inv-panel blk-launch" aria-labelledby="blk-launch-title" data-testid="section-bulk-launch">
          <div className="blk-launch-main">
            <div className="inv-kicker">02 / Launch</div>
            <h2 id="blk-launch-title"><span data-testid="text-selected-count">{selected.size}</span> of {maxBatch} brands selected</h2>
            {selected.size > 0 ? (
              <ul className="blk-chosen">{[...selected.values()].map(c => (
                <li key={c.profileId}>{c.profileName}<button type="button" aria-label={`Remove ${c.profileName}`} onClick={() => toggle(c)}><X size={11} /></button></li>
              ))}</ul>
            ) : <p className="blk-quiet">Tick brands above. Selection is kept on this device across pages and reloads.</p>}
          </div>
          <div className="blk-launch-side">
            <div className="blk-paid"><CircleAlert size={15} /><p><b>Paid service.</b> Each brand calls paid discovery and verification providers. Shown cost estimates exclude provider credits and failed calls.</p></div>
            <label className="blk-ack"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} data-testid="checkbox-ack-paid" /> I understand this run will make paid requests.</label>
            <button type="button" className="inv-submit" disabled={!ack || selected.size === 0 || start.isPending} onClick={submit} data-testid="button-start-bulk">
              {start.isPending ? 'Starting run' : `Start ${selected.size || ''} ${selected.size === 1 ? 'brand' : 'brands'}`} <ArrowRight size={16} />
            </button>
            {selected.size > 0 && <button type="button" className="blk-link" onClick={() => setSelected(new Map())}>Clear selection</button>}
            {start.isError && <p className="inv-form-error" role="alert" data-testid="text-start-error">{apiError(start.error, 'The run could not be started.')} Retrying the same selection is safe.</p>}
          </div>
        </section>

        {runId && <RunDetail key={runId} runId={runId} onClose={() => setRunId(null)} />}
        <RunList activeId={runId ?? undefined} onOpen={setRunId} />
      </main>
      <footer className="inv-footer inv-wrap"><span>PROFILE HANDLES ONLINE / BULK BRANDS</span><span>Not found means no supported account was found, not that none exists.</span></footer>
    </div>
  );
}
