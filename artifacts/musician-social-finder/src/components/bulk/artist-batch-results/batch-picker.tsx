import type { ArtistResultBatch } from '@workspace/api-client-react';
import { usd } from './model';

export function BatchPicker({ batches, selected, onSelect }: { batches: ArtistResultBatch[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="abr-batches" role="radiogroup" aria-label="Result batch">
      {batches.map(b => {
        const on = b.id === selected;
        return (
          <button key={b.id} type="button" role="radio" aria-checked={on} className={`abr-batch${on ? ' on' : ''}`} onClick={() => onSelect(b.id)} data-testid={`button-batch-${b.id}`}>
            <span className="abr-batch-top"><b className={`abr-src s-${b.source}`}>{b.source}</b><span className="inv-mono">{new Date(b.createdAt).toLocaleDateString()}</span></span>
            <strong>{b.title}</strong>
            <span className="abr-batch-meta inv-mono">{b.artistCount.toLocaleString()} artists · {b.source === 'live' && b.rowCount === 0 ? 'counts load on open' : `${b.rowCount.toLocaleString()} rows · ${b.verifiedCount} verified`}</span>
            <span className="abr-batch-meta">{b.status} · reported {usd(b.reportedUsd)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function BatchSummary({ b }: { b: ArtistResultBatch }) {
  if (b.source === 'live' && b.rowCount === 0) return <p className="abr-explain" role="status">Loading this batch’s saved candidate counts. Missing counts are not zero results.</p>;
  const stats: [string, number | string][] = [
    ['Artists', b.artistCount], ['Candidates', b.candidateCount], ['Rows', b.rowCount], ['Verified', b.verifiedCount],
    ['Review', b.reviewCount], ['Not inspected', b.notInspectedCount], ['Metadata unavailable', b.metadataFailedCount], ['No candidate', b.noCandidateCount],
    ['Reserved', usd(b.reservedUsd)], ['Reported', usd(b.reportedUsd)],
  ];
  return (
    <div className="abr-summary" data-testid={`summary-batch-${b.id}`}>
      <dl className="abr-stats">{stats.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="inv-mono">{typeof v === 'number' ? v.toLocaleString() : v}</dd></div>)}</dl>
      <p className="abr-explain">{b.explanation || 'No explanation was saved with this batch.'}</p>
    </div>
  );
}
