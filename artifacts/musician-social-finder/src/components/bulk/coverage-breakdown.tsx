import { useState } from 'react';
import {
  useListBulkCoverageProfiles, getListBulkCoverageProfilesQueryKey,
  type BulkCoverageBucket, type BulkCoverageGroup, type BulkCoverageState,
  type BulkCoveragePlatform,
} from '@workspace/api-client-react';
import { apiError, type ProfileKind } from '@/lib/bulk';

const STATES: { state: BulkCoverageState; label: string }[] = [
  { state: 'likely_only', label: 'Likely only' },
  { state: 'needs_review', label: 'Needs review' },
  { state: 'no_match', label: 'Completed no-match' },
  { state: 'explicit_absence', label: 'Explicit absence' },
  { state: 'provider_failure', label: 'Provider failure' },
  { state: 'unresolved', label: 'Unresolved / in progress' },
];
type Selection = { platform: BulkCoveragePlatform['platform']; state: BulkCoverageState };
const safeUrl = (url: string) => /^https?:\/\//i.test(url);

function CoverageProfiles({ kind, group, selection, onClose }: {
  kind: ProfileKind; group: BulkCoverageGroup; selection: Selection; onClose: () => void;
}) {
  const [cursors, setCursors] = useState([0]);
  const cursor = cursors[cursors.length - 1];
  const q = useListBulkCoverageProfiles(kind, group, selection.platform, selection.state, cursor, 25,
    { query: { queryKey: getListBulkCoverageProfilesQueryKey(kind, group, selection.platform, selection.state, cursor, 25), staleTime: 30_000 } });
  const label = STATES.find(s => s.state === selection.state)!.label;
  return (
    <div className="blk-cov-profiles" aria-live="polite" data-testid="coverage-profiles">
      <div className="blk-cov-head">
        <h3>{selection.platform} · {label}</h3>
        <button type="button" className="inv-retry" onClick={onClose}>Close list</button>
      </div>
      <p>Read-only saved evidence. Opening this list or its links does not start a lookup or paid retry.</p>
      {q.isLoading ? <p role="status">Loading profiles…</p> : q.isError ? (
        <div role="alert">
          <p>Profiles could not be loaded. {apiError(q.error, '')}</p>
          <button type="button" className="inv-retry" disabled={q.isFetching} onClick={() => q.refetch()}>Reload list</button>
        </div>
      ) : q.data && (
        <>
          {q.data.profiles.length === 0 ? <p>No profiles currently match this bucket. Counts may be cached for up to five minutes.</p> : (
            <ul className="blk-cov-profile-list">
              {q.data.profiles.map(profile => (
                <li key={profile.profileId}>
                  <strong>{profile.profileName || `Profile ${profile.profileId}`}</strong>
                  <span className="inv-mono"> ID {profile.profileId} · {profile.tier === null ? 'Unranked' : `Tier ${profile.tier}`}</span>
                  <p>{profile.reason}</p>
                  <div className="blk-cov-links">
                    {safeUrl(profile.referenceUrl) && <a href={profile.referenceUrl} target="_blank" rel="noreferrer">Reference account</a>}
                    {profile.evidenceUrls.filter(safeUrl).map((url, index) => (
                      <a href={url} target="_blank" rel="noreferrer" key={`${url}-${index}`}>Evidence {index + 1}</a>
                    ))}
                  </div>
                  <small>Checked: {profile.checkedAt ? new Date(profile.checkedAt).toLocaleString() : 'No completed check'} · {profile.sourceHistoryId ? `Saved single investigation: ${profile.sourceHistoryId}` : `Saved run: ${profile.sourceRunId}`}</small>
                </li>
              ))}
            </ul>
          )}
          <div className="blk-cov-pages">
            <button type="button" className="inv-retry" disabled={cursors.length === 1 || q.isFetching} onClick={() => setCursors(c => c.slice(0, -1))}>Previous</button>
            <span>Page {cursors.length} · up to 25 profiles</span>
            <button type="button" className="inv-retry" disabled={!q.data.hasMore || q.isFetching} onClick={() => setCursors(c => [...c, q.data!.nextAfterId])}>Next</button>
          </div>
          <p>Live list as of {new Date(q.data.generatedAt).toLocaleString()}. Membership may change as catalog records and saved evidence change.</p>
        </>
      )}
    </div>
  );
}

export function CoverageBreakdown({ kind, bucket }: { kind: ProfileKind; bucket: BulkCoverageBucket }) {
  const [selection, setSelection] = useState<Selection>();
  return (
    <div className="blk-cov-breakdown">
      <p><strong>{bucket.uncoveredInvestigated.toLocaleString()} investigated profiles lack identity confirmation on at least one platform</strong> · {bucket.investigated.toLocaleString()} investigated / {bucket.total.toLocaleString()} active profiles</p>
      <p>This is stricter than the donuts above: saved candidate links count toward link coverage even when identity is unverified. Counts below show platform outcomes for profiles that do not have identity confirmation or sourced absence on every platform. A profile can appear under multiple platforms. Select a count to view saved evidence across all runs.</p>
      <div className="blk-cov-table-scroll">
        <table className="blk-cov-table">
          <caption className="sr-only">Platform outcomes for investigated profiles without identity confirmation on every platform</caption>
          <thead><tr><th scope="col">Platform</th>{STATES.map(s => <th key={s.state} scope="col">{s.label}</th>)}</tr></thead>
          <tbody>{bucket.platformBreakdown.map(p => (
            <tr key={p.platform}>
              <th scope="row">{p.platform}</th>
              {STATES.map(s => {
                const count = p.states.find(c => c.state === s.state)?.count ?? 0;
                return <td key={s.state}><button type="button" disabled={count === 0}
                  aria-label={`View ${count.toLocaleString()} ${p.platform} ${s.label.toLowerCase()} profiles`}
                  aria-pressed={selection?.platform === p.platform && selection.state === s.state}
                  onClick={() => setSelection({ platform: p.platform, state: s.state })}
                  data-testid={`coverage-bucket-${p.platform}-${s.state}`}>{count.toLocaleString()}</button></td>;
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p>Likely matches need verification. Completed no-match means no supported match was found, <strong>not confirmed absence</strong>. Explicit absence records a sourced first-party statement: that platform is resolved, but another platform (or an unfinished investigation) still prevents full coverage. Provider failure means the search failed or a required provider was unavailable. Unresolved includes running or missing platform evidence.</p>
      {selection && <CoverageProfiles key={`${selection.platform}-${selection.state}`} kind={kind} group={bucket.group} selection={selection} onClose={() => setSelection(undefined)} />}
    </div>
  );
}
