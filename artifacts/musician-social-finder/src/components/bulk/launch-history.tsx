import type { BulkBrandRun } from '@workspace/api-client-react';
import { KIND_META } from '../../lib/bulk';
import { sourceLabel } from '../../lib/bulk-launch-label';

export function LaunchHistory({ run }: { run: BulkBrandRun }) {
  const history = run.launchHistory ?? [];
  const start = history.find(event => event.action === 'start');
  return (
    <details className="blk-launch-history" data-testid="section-launch-history">
      <summary>
        Launch history · {start ? sourceLabel(start.source) : 'Start source not recorded (older run)'}
        {history.length > 0 && ` · ${history.length} accepted ${history.length === 1 ? 'action' : 'actions'}`}
      </summary>
      <p>Sources are browser-provided UI labels, not proof of who started a run or authorization.</p>
      {run.archiveOf && <p>This is an automatically saved chunk of the parent run, not a new paid Start. History below is the parent history when this chunk was saved.</p>}
      {run.continuous && <p>Automatic chunk continuation uses the accepted Start settings and does not create another Start.</p>}
      {!history.length && <p>No launch metadata was saved for this older run. Its source cannot be inferred from the current page.</p>}
      {history.length > 0 && history[0].action !== 'start' && <p>The original Start source was not recorded for this older run.</p>}
      <ol>
        {history.map(event => <li key={event.requestId}>
          <b>{event.action === 'start' ? 'Paid Start accepted' : 'Explicit paid Resume accepted'} · {sourceLabel(event.source)}</b>
          <div><time dateTime={event.acceptedAt}>{new Date(event.acceptedAt).toLocaleString()}</time> · Chunk {event.chunkNumber}</div>
          <div>Request ID: <code>{event.requestId}</code></div>
          <div>{event.settings.continuous ? 'Continuous' : 'One chunk'} · {event.settings.scopes.map(scope => `${KIND_META[scope.profileType].plural}: ${scope.limit}${event.settings.continuous ? '/chunk' : ''}`).join(' · ')}</div>
          {event.settings.workersPerType !== undefined && <div>Parallel workers per type: {event.settings.workersPerType}</div>}
          {event.settings.continuous && <div>Total profile cap: {event.settings.profileLimit ?? 'None (all remaining)'} · Catalog ID ceiling: {event.settings.upperProfileId ?? 'Not recorded'}</div>}
          {!!event.settings.profileIds?.length && <details><summary>{event.settings.profileIds.length} accepted profile IDs</summary><p>{event.settings.profileIds.join(', ')}</p></details>}
        </li>)}
      </ol>
    </details>
  );
}
