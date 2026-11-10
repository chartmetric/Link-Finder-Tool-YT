import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { getDownloadArtistResultCsvUrl, getGetArtistResultRowsQueryKey, getListArtistResultBatchesQueryKey, useGetArtistResultRows, useListArtistResultBatches } from '@workspace/api-client-react';
import { apiError } from '@/lib/bulk';
import { FILTERS, PAGE_SIZE, type ResultFilter } from './model';
import { BatchPicker, BatchSummary } from './batch-picker';
import { ResultRow } from './result-row';
import './artist-batch-results.css';

// No shared apiUrl helper exists in this app; customFetch only prefixes when setBaseUrl is configured (it is not for web).
// Mirror the router base so the link stays inside this artifact's route.
const base = () => import.meta.env.BASE_URL.replace(/\/$/, '');

export function ArtistBatchResults() {
  const list = useListArtistResultBatches({ query: { queryKey: getListArtistResultBatchesQueryKey(), staleTime: 30_000, refetchInterval: 30_000 } });
  const batches = list.data?.batches ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const batchId = picked && batches.some(b => b.id === picked) ? picked : batches[0]?.id ?? null;
  const batch = batches.find(b => b.id === batchId) ?? null;

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ResultFilter>('all');
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => { setOffset(0); setExpanded(new Set()); }, [batchId, search, filter]);
  useEffect(() => { setExpanded(new Set()); }, [offset]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const onSearch = (v: string) => {
    setSearchInput(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSearch(v.trim().slice(0, 120)), 300);
  };

  const searchTerm = encodeURIComponent(`q:${search.trim()}`);
  const safeId = encodeURIComponent(batchId ?? '');
  const rows = useGetArtistResultRows(safeId, offset, PAGE_SIZE, searchTerm, filter, { query: {
    queryKey: getGetArtistResultRowsQueryKey(safeId, offset, PAGE_SIZE, searchTerm, filter), enabled: !!batchId, staleTime: 30_000,
  } });
  const page = rows.data && rows.data.batch.id === batchId ? rows.data : undefined;
  const total = page?.total ?? 0;
  const toggle = (id: string) => setExpanded(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <section className="blk-cov abr" aria-labelledby="abr-title" data-testid="section-artist-batch-results">
      <div className="blk-cov-head">
        <div>
          <div className="inv-kicker">Results / Instagram discovery and verification</div>
          <h2 id="abr-title">Saved artist batch results</h2>
        </div>
        <div className="blk-ig-head-actions">
          <button type="button" className="inv-retry" onClick={() => { list.refetch(); if (batchId) rows.refetch(); }} disabled={list.isFetching || rows.isFetching} data-testid="button-refresh-artist-results">
            <RefreshCw size={12} className={list.isFetching || rows.isFetching ? 'inv-spin' : ''} /> {list.isFetching || rows.isFetching ? 'Refreshing' : 'Refresh'}
          </button>
          {batchId && <a className="inv-retry" href={`${base()}${getDownloadArtistResultCsvUrl(safeId)}`} download data-testid="link-download-artist-csv"><Download size={12} /> Full CSV</a>}
        </div>
      </div>
      <p className="abr-hint abr-lead">Read-only. Scores are uncalibrated model identity scores, not probabilities. A candidate that was not accepted is not proof of a wrong account or a missing link.</p>

      {list.data?.warnings.map((w, i) => <p key={i} className="abr-warn" role="status">{w}</p>)}

      {list.isLoading ? <div className="abr-skel" role="status" aria-label="Loading batches"><i /><i /><i /></div>
        : list.isError ? <div className="blk-cov-error" role="alert"><span>{apiError(list.error, 'Could not load saved batches.')}</span><button type="button" className="inv-retry" onClick={() => list.refetch()} data-testid="button-retry-artist-batches">Retry</button></div>
        : batches.length === 0 ? <p className="blk-cov-empty" data-testid="text-no-artist-batches">No saved artist result batches yet. Imported archives appear here once stored.</p>
        : <>
          <BatchPicker batches={batches} selected={batchId} onSelect={setPicked} />
          {batch && <BatchSummary b={page?.batch ?? batch} />}

          <div className="abr-controls">
            <label className="abr-search"><span>Search artist, profile or URL</span>
              <input type="search" value={searchInput} maxLength={120} onChange={e => onSearch(e.target.value)} placeholder="Type to filter rows" data-testid="input-artist-results-search" />
            </label>
            <div className="blk-ig-toggle" role="group" aria-label="Status filter">
              {FILTERS.map(f => <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} data-testid={`button-filter-${f.key}`}>{f.label}</button>)}
            </div>
          </div>

          {!page && rows.isLoading || (!page && rows.isFetching) ? <div className="abr-skel" role="status" aria-label="Loading rows"><i /><i /><i /><i /></div>
            : rows.isError ? <div className="blk-cov-error" role="alert"><span>{apiError(rows.error, 'Could not load rows for this batch.')}</span><button type="button" className="inv-retry" onClick={() => rows.refetch()} data-testid="button-retry-artist-rows">Retry</button></div>
            : !page || page.rows.length === 0 ? <p className="blk-cov-empty" data-testid="text-no-artist-rows">{search || filter !== 'all' ? 'No rows match this search and filter. Clear them to see the whole batch.' : 'This batch has no saved rows.'}</p>
            : <>
              <p className="abr-hint" role="status" data-testid="text-artist-rows-range">Showing {(offset + 1).toLocaleString()}–{(offset + page.rows.length).toLocaleString()} of {total.toLocaleString()} rows</p>
              <ul className="abr-rows" aria-busy={rows.isFetching}>{page.rows.map(r => <ResultRow key={r.id} row={r} open={expanded.has(r.id)} onToggle={() => toggle(r.id)} />)}</ul>
              <div className="blk-cov-pages">
                <button type="button" className="inv-retry" disabled={offset === 0 || rows.isFetching} onClick={() => setOffset(o => Math.max(0, o - PAGE_SIZE))} data-testid="button-prev-artist-rows">Previous</button>
                <span className="inv-mono abr-hint">Page {Math.floor(offset / PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
                <button type="button" className="inv-retry" disabled={page.nextOffset === null || rows.isFetching} onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)} data-testid="button-next-artist-rows">Next</button>
              </div>
            </>}
        </>}
    </section>
  );
}
