import { CircleAlert, FolderOpen, History, RefreshCw } from 'lucide-react';
import { getListBulkBrandRunsQueryKey, useListBulkBrandRuns } from '@workspace/api-client-react';
import { KIND_META, overallCounts, runKinds } from '@/lib/bulk';

export function RunList({ activeId, onOpen }: { activeId?: string; onOpen: (id: string) => void }) {
  const q = useListBulkBrandRuns({ query: { queryKey: getListBulkBrandRunsQueryKey(), refetchInterval: 5000, refetchOnMount: 'always' } });
  const runs = q.data?.runs ?? [];
  return (
    <section className="inv-panel" aria-labelledby="blk-runs-title" data-testid="section-bulk-runs">
      <div className="inv-panel-head">
        <div><div className="inv-kicker">Shared queue</div><h2 id="blk-runs-title">Recent runs</h2><p>Opening a run only views it. Nothing starts or resumes on its own.</p></div>
        <button type="button" className="inv-retry inv-history-refresh" style={{ marginTop: 0 }} disabled={q.isFetching} onClick={() => q.refetch()}><RefreshCw size={14} className={q.isFetching ? 'inv-spin' : ''} /> Refresh</button>
      </div>
      {q.isLoading && <div className="inv-history-card" aria-busy="true">{[0, 1].map(i => <div className="inv-skel" key={i} />)}</div>}
      {q.isError && <div className="inv-history-warn" role="alert"><CircleAlert size={14} /> Recent runs could not be loaded{q.data ? '; showing the last list' : ''}.<button type="button" onClick={() => q.refetch()}>Retry</button></div>}
      {q.data && runs.length === 0 && <div className="inv-empty-card"><span className="inv-state-icon"><History size={23} /></span><div className="inv-state-copy"><h3>No bulk runs yet</h3><p>Runs you start appear here for anyone on this workspace.</p></div></div>}
      {runs.length > 0 && (
        <ul className="blk-runs">
          {runs.map(run => {
            const c = overallCounts(run);
            return (
              <li key={run.id} className={run.id === activeId ? 'active' : ''} data-testid={`row-run-${run.id}`}>
                <span className={`blk-pill r-${run.status}`}>{run.status}</span>
                <div><strong className="inv-mono">{run.id.slice(0, 8)}</strong><span>{new Date(run.createdAt).toLocaleString()}</span>{(run.continuous || run.archiveOf) && <i className="blk-tag" style={{ alignSelf: 'flex-start' }} data-testid={`tag-run-mode-${run.id}`}>{run.archiveOf ? `chunk ${run.batchNumber ?? ''} of ${run.archiveOf.slice(0, 8)}` : `continuous · ${run.continuous!.batches} saved chunks`}</i>}<em className="blk-kinds" data-testid={`text-run-scopes-${run.id}`}>{runKinds(run).map(k => <i key={k} className={`blk-kind k-${k}`}>{KIND_META[k].label}</i>)}</em></div>
                <span className="inv-mono blk-runs-n">{run.continuous ? `${c.completed} done` : `${c.completed}/${run.items.length} done`}{c.failed ? ` · ${c.failed} failed` : ''}</span>
                <span className="inv-mono blk-runs-n">${run.estimatedCostUsd.toFixed(4)}</span>
                <button type="button" className="inv-retry" style={{ marginTop: 0 }} onClick={() => onOpen(run.id)} data-testid={`button-open-run-${run.id}`}><FolderOpen size={13} /> {run.id === activeId ? 'Viewing' : 'Open'}</button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
