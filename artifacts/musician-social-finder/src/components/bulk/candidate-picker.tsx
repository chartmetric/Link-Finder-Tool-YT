import { useEffect, useState } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { ArrowUpRight, ChevronLeft, ChevronRight, CircleAlert, Inbox, RefreshCw } from 'lucide-react';
import { getListBulkBrandCandidatesQueryKey, useListBulkBrandCandidates, type BulkBrandCandidate } from '@workspace/api-client-react';
import { PlatformIcon } from '@/pages/SingleArtist';
import { KIND_META, shortUrl, type ProfileKind } from '@/lib/bulk';

const LIMITS = [10, 15, 25];

export function CandidatePicker({ kind, selected, onToggle, onSetMany, maxBatch, onMaxBatch }: {
  kind: ProfileKind;
  selected: Map<number, BulkBrandCandidate>;
  onToggle: (c: BulkBrandCandidate) => void;
  onSetMany: (cs: BulkBrandCandidate[], on: boolean) => void;
  maxBatch: number;
  onMaxBatch: (n: number) => void;
}) {
  const [limit, setLimit] = useState(10);
  const [cursors, setCursors] = useState<number[]>([0]);
  const afterId = cursors[cursors.length - 1];
  const params = { limit, afterId, profileType: kind };
  const m = KIND_META[kind]; const pl = m.plural.toLowerCase();
  const q = useListBulkBrandCandidates(params, {
    query: { queryKey: getListBulkBrandCandidatesQueryKey(params), placeholderData: keepPreviousData, staleTime: 30000 },
  });
  const rows = q.data?.profiles ?? [];
  const serverMax = q.data?.maxBatchSize;
  useEffect(() => { if (serverMax && serverMax !== maxBatch) onMaxBatch(serverMax); }, [serverMax, maxBatch, onMaxBatch]);
  const allOn = rows.length > 0 && rows.every(r => selected.has(r.profileId));
  const room = maxBatch - selected.size;

  return (
    <section className="inv-panel blk-picker" aria-labelledby="blk-pick-title" data-testid="section-bulk-candidates">
      <div className="inv-panel-head">
        <div><div className="inv-kicker">01 / Eligible {pl}</div><h2 id="blk-pick-title">Pick a batch to investigate</h2><p>{m.plural} in every tier with exactly one distinct active catalog account. The catalog is read only.</p></div>
        <label className="blk-limit">
          <span className="inv-mono">Rows per page</span>
          <select value={limit} onChange={e => { setLimit(Number(e.target.value)); setCursors([0]); }} data-testid="select-candidate-limit">
            {LIMITS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      {q.isLoading && <div className="inv-history-card" aria-busy="true" data-testid="status-candidates-loading">{[0, 1, 2, 3].map(i => <div className="inv-skel" key={i} />)}</div>}

      {q.isError && (
        <div className={q.data ? 'inv-history-warn' : 'inv-error-card'} role="alert" data-testid="status-candidates-error">
          {q.data ? <><CircleAlert size={14} /> Could not refresh this page; showing the last loaded rows.<button type="button" onClick={() => q.refetch()}>Retry</button></> : <>
            <span className="inv-state-icon"><CircleAlert size={23} /></span>
            <div className="inv-state-copy"><h3>Eligible {pl} could not be loaded.</h3><p>The bulk service may still be starting. Nothing has been run.</p>
              <button type="button" className="inv-retry" onClick={() => q.refetch()} data-testid="button-retry-candidates"><RefreshCw size={14} /> Retry</button></div>
          </>}
        </div>
      )}

      {q.data && rows.length === 0 && (
        <div className="inv-empty-card" data-testid="status-candidates-empty">
          <span className="inv-state-icon"><Inbox size={23} /></span>
          <div className="inv-state-copy"><h3>{cursors.length > 1 ? `No more eligible ${pl}` : `No eligible ${pl} right now`}</h3><p>Only {pl} with exactly one distinct active linked account appear here.</p>
            {cursors.length > 1 && <button type="button" className="inv-retry" onClick={() => setCursors([0])}>Back to first page</button>}</div>
        </div>
      )}

      {q.data && rows.length > 0 && (
        <div className="inv-history-card">
          <div className="inv-history-scroll">
            <table className="inv-history-table blk-table" data-testid="table-bulk-candidates">
              <thead><tr>
                <th className="blk-check-col"><input type="checkbox" aria-label={`Select every ${m.label.toLowerCase()} on this page`} checked={allOn} disabled={!allOn && rows.filter(r => !selected.has(r.profileId)).length > room} onChange={() => onSetMany(rows, !allOn)} data-testid="checkbox-select-page" /></th>
                <th>{m.label}</th><th>Tier</th><th>Known account</th>
              </tr></thead>
              <tbody>
                {rows.map(row => {
                  const on = selected.has(row.profileId);
                  const id = `blk-c-${row.profileId}`;
                  return (
                    <tr key={row.profileId} className={on ? 'active' : ''} data-testid={`row-candidate-${row.profileId}`}>
                      <td className="blk-check-col"><input id={id} type="checkbox" checked={on} disabled={!on && room <= 0} onChange={() => onToggle(row)} data-testid={`checkbox-candidate-${row.profileId}`} /></td>
                      <td><label htmlFor={id}><strong>{row.profileName}</strong><span className="blk-sub inv-mono">#{row.profileId}</span></label></td>
                      <td className="inv-mono blk-tier">T{row.tier} <span>rank {row.tierRank}</span></td>
                      <td><a className="inv-history-ref blk-acct" href={row.url} target="_blank" rel="noopener noreferrer"><PlatformIcon platform={row.platform} size={12} /> @{row.handle.replace(/^@/, '')} <span>{shortUrl(row.url)}</span> <ArrowUpRight size={11} aria-hidden="true" /></a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="inv-history-pager">
            <span className="inv-mono">Page {cursors.length}{q.isFetching ? ' · loading' : ''}</span>
            <div>
              <button type="button" className="inv-retry" style={{ marginTop: 0 }} disabled={cursors.length <= 1 || q.isFetching} onClick={() => setCursors(c => c.slice(0, -1))} data-testid="button-candidates-prev"><ChevronLeft size={14} /> Previous</button>
              <button type="button" className="inv-retry" style={{ marginTop: 0 }} disabled={!q.data.hasMore || q.isFetching} onClick={() => setCursors(c => [...c, q.data!.nextAfterId])} data-testid="button-candidates-next">Next <ChevronRight size={14} /></button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
