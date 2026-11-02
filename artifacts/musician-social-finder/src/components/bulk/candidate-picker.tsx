import { useEffect, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, CircleAlert, Inbox, RefreshCw } from 'lucide-react';
import { getListBulkBrandCandidatesQueryKey, useListBulkBrandCandidates, type BulkBrandCandidate } from '@workspace/api-client-react';
import { PlatformIcon } from '@/pages/SingleArtist';
import { canInvestigate, KIND_META, shortUrl, type ProfileKind } from '@/lib/bulk';

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
  const [draftSearch, setDraftSearch] = useState('');
  const [search, setSearch] = useState('');
  const [tier, setTier] = useState<number | undefined>();
  const [cursors, setCursors] = useState<number[]>([0]);
  const afterId = cursors[cursors.length - 1];
  const params = { limit, afterId, profileType: kind, search: search || undefined, tier };
  const m = KIND_META[kind]; const pl = m.plural.toLowerCase();
  const q = useListBulkBrandCandidates(params, {
    // Never expose a previous filter/type's rows as selectable current results.
    query: { queryKey: getListBulkBrandCandidatesQueryKey(params), staleTime: 30000 },
  });
  const rows = q.data?.profiles ?? [];
  const serverMax = q.data?.maxBatchSize;
  useEffect(() => { if (serverMax && serverMax !== maxBatch) onMaxBatch(serverMax); }, [serverMax, maxBatch, onMaxBatch]);
  const runnable = rows.filter(canInvestigate);
  const allOn = runnable.length > 0 && runnable.every(r => selected.has(r.profileId));
  const room = maxBatch - selected.size;
  const filtered = !!search || tier !== undefined;
  const clearFilters = () => { setDraftSearch(''); setSearch(''); setTier(undefined); setCursors([0]); };

  return (
    <section className="inv-panel blk-picker" aria-labelledby="blk-pick-title" data-testid="section-bulk-candidates">
      <div className="inv-panel-head">
        <div><div className="inv-kicker">01 / All {pl}</div><h2 id="blk-pick-title">Browse profiles and pick a batch</h2><p>All catalog {pl}, including unranked and unlinked profiles. Discovery requires at least one usable existing link. The catalog is read only.</p></div>
        <label className="blk-limit">
          <span className="inv-mono">Rows per page</span>
          <select value={limit} onChange={e => { setLimit(Number(e.target.value)); setCursors([0]); }} data-testid="select-candidate-limit">
            {LIMITS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <form className="blk-filters" role="search" aria-label={`Search catalog ${pl}`} onSubmit={e => {
        e.preventDefault();
        setSearch(draftSearch.trim().replace(/^@/, '').trim());
        setCursors([0]);
      }}>
        <label className="blk-limit blk-search">
          <span className="inv-mono">Name or handle</span>
          <input type="search" value={draftSearch} maxLength={120} placeholder="Search name or @handle"
            onChange={e => setDraftSearch(e.target.value)} data-testid="input-candidate-search" />
        </label>
        <button type="submit" className="inv-retry" data-testid="button-search-candidates">Search</button>
        <label className="blk-limit">
          <span className="inv-mono">Tier</span>
          <select value={tier ?? ''} onChange={e => { setTier(e.target.value ? Number(e.target.value) : undefined); setCursors([0]); }} data-testid="select-candidate-tier">
            <option value="">All tiers</option>
            {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>Tier {n}</option>)}
          </select>
        </label>
        {(filtered || draftSearch) && <button type="button" className="inv-retry" onClick={clearFilters} data-testid="button-clear-candidate-filters">Clear filters</button>}
        <p className="blk-filter-note" aria-live="polite" data-testid="text-candidate-filters">
          {search ? `Showing matches for “${search}”` : 'Showing all names and handles'}{tier !== undefined ? ` · Tier ${tier}` : ' · All tiers'}.
          {' '}Selections stay selected when hidden by filters. Searching never starts a lookup.
        </p>
      </form>

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
          <div className="inv-state-copy"><h3>{cursors.length > 1 ? `No more ${pl}` : filtered ? `No ${pl} match these filters` : `No ${pl} found`}</h3><p>This list includes profiles with zero, one, or multiple active accounts.</p>
            {filtered && <button type="button" className="inv-retry" onClick={clearFilters}>Clear filters</button>}
            {cursors.length > 1 && <button type="button" className="inv-retry" onClick={() => setCursors([0])}>Back to first page</button>}</div>
        </div>
      )}

      {q.data && rows.length > 0 && (
        <div className="inv-history-card">
          <div className="inv-history-scroll">
            <table className="inv-history-table blk-table" data-testid="table-bulk-candidates">
              <thead><tr>
                <th className="blk-check-col"><input type="checkbox" aria-label={`Select every runnable ${m.label.toLowerCase()} on this page`} checked={allOn} disabled={runnable.length === 0 || (!allOn && runnable.filter(r => !selected.has(r.profileId)).length > room)} onChange={() => onSetMany(runnable, !allOn)} data-testid="checkbox-select-page" /></th>
                <th>{m.label}</th><th>Tier</th><th>Known account</th>
              </tr></thead>
              <tbody>
                {rows.map(row => {
                  const on = selected.has(row.profileId);
                  const id = `blk-c-${row.profileId}`;
                  return (
                    <tr key={row.profileId} className={on ? 'active' : ''} data-testid={`row-candidate-${row.profileId}`}>
                      <td className="blk-check-col"><input id={id} type="checkbox" checked={on} disabled={!on && (!canInvestigate(row) || room <= 0)} title={row.investigationBlockedReason} onChange={() => onToggle(row)} data-testid={`checkbox-candidate-${row.profileId}`} /></td>
                      <td><label htmlFor={id}><strong>{row.profileName}</strong><span className="blk-sub inv-mono">#{row.profileId}</span></label></td>
                      <td className="inv-mono blk-tier">{row.tier == null ? 'Unranked' : `T${row.tier}`} {row.tierRank != null && <span>rank {row.tierRank}</span>}</td>
                      <td>
                        <span className="blk-sub inv-mono">{row.accountCount ?? 1} active {(row.accountCount ?? 1) === 1 ? 'account' : 'accounts'}</span>
                        {canInvestigate(row) ? <a className="inv-history-ref blk-acct" href={row.url} target="_blank" rel="noopener noreferrer"><PlatformIcon platform={row.platform} size={12} /> {row.handle ? `@${row.handle.replace(/^@/, '')}` : 'Reference link'} <span>{shortUrl(row.url)}</span> <ArrowUpRight size={11} aria-hidden="true" /></a>
                          : <span className="blk-sub" data-testid={`blocked-candidate-${row.profileId}`}>{row.investigationBlockedReason ?? 'An existing link is required for discovery.'}</span>}
                        {(row.accounts?.length ?? 0) > 1 && <details><summary className="blk-sub">All linked accounts · reference shown above</summary>{row.accounts!.map(account => (
                          <div className="blk-sub inv-mono" style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }} key={account.accountId}>{account.platform}: {account.url || account.handle || 'No URL stored'}</div>
                        ))}</details>}
                      </td>
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
