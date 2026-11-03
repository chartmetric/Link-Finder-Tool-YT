import { useState } from 'react';
import { Archive, CircleAlert } from 'lucide-react';
import { getListBulkRunBatchesQueryKey, useListBulkRunBatches } from '@workspace/api-client-react';
import { apiError, runCounts } from '@/lib/bulk';

/** Paginated list of archived chunks of a continuous run. */
export function BatchArchive({ rootId, total, onOpenRun }: { rootId: string; total: number; onOpenRun: (id: string) => void }) {
  const [cursors, setCursors] = useState<number[]>([0]);
  const after = cursors[cursors.length - 1];
  const q = useListBulkRunBatches(rootId, after, { query: { queryKey: [...getListBulkRunBatchesQueryKey(rootId, after), total], enabled: total > 0 } });
  if (total === 0) return null;
  return (
    <div className="blk-archive" data-testid="section-batch-archive">
      <h3><Archive size={12} style={{ display: 'inline', verticalAlign: '-1px' }} /> Saved chunks ({total})</h3>
      {q.isLoading && <div className="inv-skel" />}
      {q.isError && <div className="inv-history-warn" role="alert"><CircleAlert size={14} /> {apiError(q.error, 'Saved chunks could not be loaded.')}<button type="button" onClick={() => q.refetch()}>Retry</button></div>}
      {q.data && (
        <ul>{q.data.runs.map(r => { const c = runCounts(r); return (
          <li key={r.id}><button type="button" onClick={() => onOpenRun(r.id)} data-testid={`button-open-chunk-${r.id}`}>Chunk {r.batchNumber ?? '?'} · {c.completed}/{r.items.length}{c.failed ? ` · ${c.failed} failed` : ''}{c.skipped ? ` · ${c.skipped} skipped` : ''}</button></li>); })}</ul>
      )}
      <div className="blk-archive-more">
        {cursors.length > 1 && <button type="button" className="inv-retry" style={{ marginTop: 0 }} onClick={() => setCursors(cs => cs.slice(0, -1))} data-testid="button-chunks-prev">Earlier page</button>}
        {q.data?.hasMore && <button type="button" className="inv-retry" style={{ marginTop: 0 }} onClick={() => setCursors(cs => [...cs, q.data!.nextBatch])} data-testid="button-chunks-next">Later chunks</button>}
      </div>
    </div>
  );
}
