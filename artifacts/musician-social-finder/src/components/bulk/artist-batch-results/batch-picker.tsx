import type { ArtistResultBatch } from '@workspace/api-client-react';
import { tryJson, usd } from './model';
import { JsonValue } from './json-tree';
import { alternativesObservation, groupObservations } from './alternatives-observations';

export function BatchPicker({ batches, selected, onSelect }: { batches: ArtistResultBatch[]; selected: string | null; onSelect: (id: string) => void }) {
  const groups = groupObservations(batches);
  const current = batches.find(b => b.id === selected);
  const observation = current && alternativesObservation(current);
  const finals = observation?.runKey && observation.kind === 'checkpoint'
    ? batches.filter(b => {
      const other = alternativesObservation(b);
      return other?.runKey === observation.runKey && other.kind === 'final';
    }) : [];
  return (
    <>
    <div className="abr-batches" role="radiogroup" aria-label="Result batch">
      {groups.map(group => {
        const run = alternativesObservation(group.batches[0]);
        return <div className="abr-run-group" key={group.key} role="group" aria-label={run?.parentBudget ? `Approved run ${run.parentBudget}, scope ${run.scope}` : 'Saved batch'}>
          {run && <div className="abr-run-heading" data-testid={`text-run-${group.batches[0].id}`}>
            <strong>{run.runKey ? 'Approved run' : 'Ungrouped alternatives archive'} · {group.batches.length} saved {group.batches.length === 1 ? 'observation' : 'observations'}</strong>
            <span>Parent budget: {run.parentBudget ?? 'Not recorded — not grouped with other archives'}</span>
            <span className="inv-mono">Scope hash prefix: {run.scope}</span>
            <span>Separate snapshots; spending is not additive.</span>
          </div>}
          {group.batches.map(b => {
        const on = b.id === selected;
        const saved = alternativesObservation(b);
        return (
          <button key={b.id} type="button" role="radio" aria-checked={on} className={`abr-batch${on ? ' on' : ''}`} onClick={() => onSelect(b.id)} data-testid={`button-batch-${b.id}`}>
            <span className="abr-batch-top"><b className={`abr-src s-${b.source}`}>{b.source}</b><span className="inv-mono">{new Date(b.createdAt).toLocaleDateString()}</span></span>
            <strong>{b.title}</strong>
            {saved && <>
              <span className="abr-batch-meta">{saved.kind === 'final' ? 'Final saved summary' : saved.kind === 'checkpoint' ? 'Interrupted / durable checkpoint' : 'Observation type not recorded'}</span>
              <span className="abr-batch-meta inv-mono">Observation: {saved.checkpoint}</span>
            </>}
            <span className="abr-batch-meta inv-mono">{b.artistCount.toLocaleString()} artists · {b.source === 'live' && b.rowCount === 0 ? 'counts load on open' : `${b.rowCount.toLocaleString()} rows · ${b.verifiedCount} verified`}</span>
            <span className="abr-batch-meta">{b.status} · reported {usd(b.reportedUsd)}</span>
          </button>
        );
          })}
        </div>;
      })}
    </div>
    {observation && <div className="abr-observation-note" data-testid="text-observation-navigation">
      <p>Read-only observations. Opening another archive does not replace this evidence, resume work or authorize spending.</p>
      {observation.kind === 'checkpoint' && (finals.length
        ? <div className="abr-final-links"><span>A final saved observation is available for this approved run:</span>
          {finals.map(b => <button type="button" className="inv-retry" key={b.id} onClick={() => onSelect(b.id)} data-testid={`button-final-observation-${b.id}`}>
            View final saved observation · {alternativesObservation(b)!.checkpoint}
          </button>)}</div>
        : <p>No final saved observation for this run is in the loaded history. This does not authorize a retry.</p>)}
    </div>}
    </>
  );
}

export function BatchSummary({ b }: { b: ArtistResultBatch }) {
  const observation = alternativesObservation(b);
  if (b.source === 'live' && b.rowCount === 0) return <p className="abr-explain" role="status">Loading this batch’s saved candidate counts. Missing counts are not zero results.</p>;
  const stats: [string, number | string][] = [
    ['Artists', b.artistCount], ['Candidates', b.candidateCount], ['Rows', b.rowCount], ['Verified', b.verifiedCount],
    ['Review', b.reviewCount], ['Not inspected', b.notInspectedCount], ['Metadata unavailable', b.metadataFailedCount], ['No candidate', b.noCandidateCount],
    ['Conservative reservation', usd(b.reservedUsd)], ['Provider reported', usd(b.reportedUsd)],
  ];
  return (
    <div className="abr-summary" data-testid={`summary-batch-${b.id}`}>
      {observation && <div className="abr-observation-note" data-testid={`text-observation-provenance-${b.id}`}>
        <strong>{observation.kind === 'final' ? 'Final saved summary' : observation.kind === 'checkpoint' ? 'Interrupted / durable checkpoint' : 'Saved observation — type not recorded'} · {b.status}</strong>
        <p>Parent budget: {observation.parentBudget ?? 'Not recorded'}</p>
        <p className="inv-mono">Archive: {b.id}</p>
        <p>{observation.spending ?? 'Spending observation provenance not recorded.'}</p>
        <p>Displayed date: {new Date(b.createdAt).toLocaleString()}. Source: {observation.dateSource ?? 'Not recorded'}. Not an observation sequence or import time.</p>
      </div>}
      <dl className="abr-stats">{stats.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="inv-mono">{typeof v === 'number' ? v.toLocaleString() : v}</dd></div>)}</dl>
      <p className="abr-explain">{b.explanation || 'No explanation was saved with this batch.'}</p>
      {!!b.metrics?.length && <dl className="abr-stats">{b.metrics.map(m => <div key={m.label}><dt>{m.label}</dt><dd className="inv-mono">{m.value}</dd></div>)}</dl>}
      {!!b.details?.length && <details className="abr-group">
        <summary>Batch source, spending and control details</summary>
        <dl className="abr-fields">{b.details.map(f => {
          const parsed = tryJson(f.value);
          return <div className="abr-field" key={f.label}><dt>{f.label}</dt><dd>{parsed !== undefined ? <JsonValue raw={f.value} parsed={parsed} /> : <span className="abr-val">{f.value}</span>}</dd></div>;
        })}</dl>
      </details>}
    </div>
  );
}
