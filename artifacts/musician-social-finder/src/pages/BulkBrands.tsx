import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowLeft, ArrowRight, CircleAlert, X } from 'lucide-react';
import { getGetBulkBrandRunQueryKey, getListBulkBrandRunsQueryKey, useGetBulkBrandRun, useStartBulkBrandRun, type BulkBrandCandidate } from '@workspace/api-client-react';
import { CandidatePicker } from '@/components/bulk/candidate-picker';
import { RunList } from '@/components/bulk/run-list';
import { RunDetail } from '@/components/bulk/run-detail';
import { LaunchWidget } from '@/components/bulk/launch-widget';
import { AutoLauncher } from '@/components/bulk/auto-launcher';
import { isActiveRun, KIND_META, LAST_RUN_KEY, PROFILE_KINDS, apiError, kindOf, readStorage, selectionKey, writeStorage, type ProfileKind } from '@/lib/bulk';
import '@/styles/bulk.css';

type Selections = Record<ProfileKind, Map<number, BulkBrandCandidate>>;
const load = (k: ProfileKind) => new Map(readStorage<BulkBrandCandidate[]>(selectionKey(k), []).filter(c => kindOf(c) === k).map(c => [c.profileId, c]));

export default function BulkBrands() {
  const qc = useQueryClient();
  const [location] = useLocation();
  const kind: ProfileKind = location.endsWith('/creators') ? 'creator' : location.endsWith('/artists') ? 'artist' : 'brand';
  const m = KIND_META[kind];
  const noun = (n: number) => (n === 1 ? m.label : m.plural).toLowerCase();
  const [sel, setSel] = useState<Selections>(() => ({ brand: load('brand'), creator: load('creator'), artist: load('artist') }));
  const selected = sel[kind];
  const [maxBatch, setMaxBatch] = useState(25);
  const [runId, setRunId] = useState<string | null>(() => readStorage<string | null>(LAST_RUN_KEY, null));
  const [ack, setAck] = useState(false);
  const pendingRequest = useRef<{ id: string; key: string } | null>(null);
  const start = useStartBulkBrandRun();
  const busy = useIsMutating() > 0;
  const currentRun = useGetBulkBrandRun(runId ?? '', { query: { queryKey: getGetBulkBrandRunQueryKey(runId ?? ''), enabled: !!runId } });
  const rootId = runId ? currentRun.data?.archiveOf : undefined;
  const rootRun = useGetBulkBrandRun(rootId ?? '', { query: { queryKey: getGetBulkBrandRunQueryKey(rootId ?? ''), enabled: !!rootId } });
  const startBlocked = busy || isActiveRun(currentRun.data) || (!!runId && currentRun.isLoading) || isActiveRun(rootRun.data) || (!!rootId && rootRun.isLoading);

  useEffect(() => { for (const k of PROFILE_KINDS) writeStorage(selectionKey(k), [...sel[k].values()]); }, [sel]);
  useEffect(() => { writeStorage(LAST_RUN_KEY, runId); }, [runId]);
  useEffect(() => { document.title = `Bulk ${m.label.toLowerCase()} finder · Profile Handles Online`; setAck(false); start.reset(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (fn: (prev: Map<number, BulkBrandCandidate>) => Map<number, BulkBrandCandidate>) => setSel(s => ({ ...s, [kind]: fn(s[kind]) }));
  const toggle = (c: BulkBrandCandidate) => update(prev => {
    const next = new Map(prev);
    if (next.has(c.profileId)) next.delete(c.profileId); else if (c.canInvestigate !== false && c.url && next.size < maxBatch) next.set(c.profileId, { ...c, profileType: kind });
    return next;
  });
  const setMany = (cs: BulkBrandCandidate[], on: boolean) => update(prev => {
    const next = new Map(prev);
    for (const c of cs) { if (!on) next.delete(c.profileId); else if (c.canInvestigate !== false && c.url && next.size < maxBatch) next.set(c.profileId, { ...c, profileType: kind }); }
    return next;
  });

  const ids = [...selected.keys()].sort((a, b) => a - b);
  const submit = () => {
    if (startBlocked || ids.length === 0 || !ack) return;
    const key = `${kind}:${ids.join(',')}`;
    if (!pendingRequest.current || pendingRequest.current.key !== key) pendingRequest.current = { id: crypto.randomUUID(), key };
    const submittedKind = kind;
    start.mutate({ data: { requestId: pendingRequest.current.id, profileIds: ids, profileTypes: [kind] } }, {
      onSuccess: run => {
        pendingRequest.current = null;
        qc.setQueryData(getGetBulkBrandRunQueryKey(run.id), run);
        qc.invalidateQueries({ queryKey: getListBulkBrandRunsQueryKey() });
        setRunId(run.id);
        setSel(s => ({ ...s, [submittedKind]: new Map() }));
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
            <span className="inv-brand-name">Profile Handles Online<span className="inv-brand-caption inv-mono">Bulk profile finder</span></span>
          </Link>
          <Link href="/" className="inv-back" data-testid="link-single-investigation"><ArrowLeft size={14} /> Single investigation</Link>
        </div>
      </header>

      <div className="inv-wrap blk-shell">
        <nav className="blk-side" aria-label="Profile type">
          <div className="inv-kicker blk-side-k">Scope</div>
          {PROFILE_KINDS.map(k => (
            <Link key={k} href={KIND_META[k].path} className={`blk-side-link${k === kind ? ' active' : ''}`} aria-current={k === kind ? 'page' : undefined} data-testid={`link-scope-${k}`}>
              <span className={`blk-side-code k-${k}`}>{KIND_META[k].code}</span>
              <span>{KIND_META[k].plural}</span>
              {sel[k].size > 0 && <em className="inv-mono" data-testid={`text-scope-selected-${k}`}>{sel[k].size}</em>}
            </Link>
          ))}
        </nav>

        <main className="inv-workspace blk-main">
          <div className="inv-section-head">
            <div><div className="inv-kicker">Bulk link finder / {m.plural.toLowerCase()}</div><h2>Find links across all {m.plural.toLowerCase()}</h2></div>
            <p className="inv-section-note">Results are suggestions for human review. No approvals or catalog writes happen here.</p>
          </div>

          <AutoLauncher kind={kind} blocked={!!startBlocked} onRun={setRunId} />

          <CandidatePicker key={kind} kind={kind} selected={selected} onToggle={toggle} onSetMany={setMany} maxBatch={maxBatch} onMaxBatch={setMaxBatch} />

          <section className="inv-panel blk-launch" aria-labelledby="blk-launch-title" data-testid="section-bulk-launch">
            <div className="blk-launch-main">
              <div className="inv-kicker">02 / Launch {m.plural.toLowerCase()}</div>
              <h2 id="blk-launch-title"><span data-testid="text-selected-count">{selected.size}</span> of {maxBatch} {m.plural.toLowerCase()} selected</h2>
              {selected.size > 0 ? (
                <ul className="blk-chosen">{[...selected.values()].map(c => (
                  <li key={c.profileId}>{c.profileName}<button type="button" aria-label={`Remove ${c.profileName}`} onClick={() => toggle(c)}><X size={11} /></button></li>
                ))}</ul>
              ) : <p className="blk-quiet">Tick {m.plural.toLowerCase()} above. Each scope keeps its own selection on this device across pages and reloads.</p>}
            </div>
            <div className="blk-launch-side">
              <div className="blk-paid"><CircleAlert size={15} /><p><b>Paid service.</b> Each {m.label.toLowerCase()} calls paid discovery and verification providers. Shown cost estimates exclude provider credits and failed calls.</p></div>
              <label className="blk-ack"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} data-testid="checkbox-ack-paid" /> I understand this run will make paid requests.</label>
              <button type="button" className="inv-submit" disabled={!ack || selected.size === 0 || !!startBlocked} onClick={submit} data-testid="button-start-bulk">
                {start.isPending ? 'Starting run' : `Start ${selected.size || ''} ${noun(selected.size)}`} <ArrowRight size={16} />
              </button>
              {selected.size > 0 && <button type="button" className="blk-link" onClick={() => update(() => new Map())}>Clear selection</button>}
              {start.isError && <p className="inv-form-error" role="alert" data-testid="text-start-error">{apiError(start.error, 'The run could not be started.')} Retrying the same selection is safe.</p>}
            </div>
          </section>

          {runId && <RunDetail key={runId} runId={runId} onClose={() => setRunId(null)} onOpenRun={setRunId} />}
          <RunList activeId={runId ?? undefined} onOpen={setRunId} />
        </main>
      </div>
      <LaunchWidget runId={runId} onRun={setRunId} />
      <footer className="inv-footer inv-wrap"><span>PROFILE HANDLES ONLINE / BULK {m.plural.toUpperCase()}</span><span>Not found means no supported account was found, not that none exists.</span></footer>
    </div>
  );
}
