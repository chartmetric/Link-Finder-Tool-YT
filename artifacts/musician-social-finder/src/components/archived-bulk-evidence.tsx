import { useState } from 'react';
import { getListArchivedBulkEvidenceQueryKey, useListArchivedBulkEvidence } from '@workspace/api-client-react';
import { EvidenceDelivery } from './evidence-delivery';

export function ArchivedBulkEvidence() {
  const [open, setOpen] = useState(false);
  const [archive, setArchive] = useState<string>();
  const [page, setPage] = useState(1);
  const params = {archive,page};
  const q = useListArchivedBulkEvidence(params, {query:{queryKey:getListArchivedBulkEvidenceQueryKey(params),enabled:open,retry:false}});
  return (
    <section className="inv-panel" aria-label="Archived bulk investigations">
      <details onToggle={e=>setOpen(e.currentTarget.open)}>
        <summary className="inv-panel-head">Archived bulk investigations · evidence delivery</summary>
        <div className="inv-archive-body">
          <p>Read-only pilot archives stored in this workspace. Saved decisions remain unchanged; no paid lookup is run. Archives unavailable in this workspace cannot be shown.</p>
          {q.isLoading && <p role="status">Loading saved evidence…</p>}
          {q.isError && <div role="alert"><p>Saved bulk evidence could not be loaded.</p><button type="button" className="inv-retry" onClick={()=>q.refetch()}>Retry archive read</button></div>}
          {q.data && <>
            {q.data.archives.length === 0 ? <p>No saved bulk pilot archives are available in this workspace.</p> : <>
              <label>Saved archive <select value={archive??q.data.archive} onChange={e=>{setArchive(e.target.value);setPage(1);}}>
                {q.data.archives.map(id=><option key={id} value={id}>{id}</option>)}
              </select></label>
              {q.data.records.map((r,i)=><details key={`${q.data.archive}-${page}-${r.profileId}-${i}`} className="inv-archive-record">
                <summary>{r.subject??`Profile ${r.profileId}`} · {r.status.replaceAll('_',' ')}</summary>
                <p>Profile {r.profileId} · Saved outcome: {r.status.replaceAll('_',' ')}{r.reason ? ` — ${r.reason}` : ''}</p>
                <p>Diagnostics source: {r.deliverySource==='saved_result'?'saved bulk result':r.deliverySource==='archived_request'?'original archived request':'not recorded'}. No evidence was reconstructed.</p>
                {r.warning && <p role="note">{r.warning}</p>}
                <EvidenceDelivery delivery={r.contextDelivery} />
                <h4>Saved candidate decisions</h4>
                {r.candidates.length ? <ul>{r.candidates.map((c,j)=><li key={`${c.url}-${j}`}><span>{c.url}</span> · {c.verdict??'No model verdict saved'}{c.sameIdentityProbability!==undefined ? ` · same-identity probability ${(c.sameIdentityProbability*100).toFixed(1)}%` : ''}</li>)}</ul> : <p>No candidate decisions were saved in this result.</p>}
              </details>)}
              {q.data.records.length === 0 && <p>No saved records on this page.</p>}
              <nav aria-label="Archived evidence pages" className="inv-archive-pages">
                <button type="button" className="inv-retry" disabled={page===1||q.isFetching} onClick={()=>setPage(p=>p-1)}>Previous</button>
                <span>Page {page}</span>
                <button type="button" className="inv-retry" disabled={!q.data.hasMore||q.isFetching} onClick={()=>setPage(p=>p+1)}>Next</button>
              </nav>
            </>}
          </>}
        </div>
      </details>
    </section>
  );
}
