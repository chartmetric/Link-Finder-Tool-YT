import { keepPreviousData } from '@tanstack/react-query';
import { ArrowUpRight, ChevronLeft, ChevronRight, CircleAlert, FolderOpen, History, RefreshCw } from 'lucide-react';
import { getListProfileInvestigationsQueryKey, useListProfileInvestigations, type ProfileInvestigation, type ProfileMatch } from '@workspace/api-client-react';

export const HISTORY_LIMIT = 20;

function host(url: string) {
  try {
    const p = new URL(url);
    return `${p.hostname.replace(/^www\./, '')}${p.pathname.replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

function verdictOf(p: ProfileMatch) {
  return p.jevVerification?.verdict ?? (p.identityComparison ? `identity ${p.identityComparison.status}` : 'unverified');
}

function refPlatform(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www|m)\./, '').split('.')[0];
  } catch {
    return '';
  }
}

export function InvestigationHistory({ page, onPageChange, onOpen, activeId, disabled }: {
  page: number;
  onPageChange: (page: number) => void;
  onOpen: (item: ProfileInvestigation) => void;
  activeId?: string;
  disabled?: boolean;
}) {
  const params = { page, limit: HISTORY_LIMIT };
  const q = useListProfileInvestigations(params, {
    query: { queryKey: getListProfileInvestigationsQueryKey(params), refetchOnMount: 'always', refetchInterval: 30000, placeholderData: keepPreviousData },
  });
  const items = q.data?.investigations ?? [];

  return (
    <section className="inv-panel inv-history" aria-labelledby="history-title" data-testid="section-investigation-history">
      <div className="inv-panel-head">
        <div><div className="inv-kicker">Saved investigations</div><h2 id="history-title">Already gathered</h2><p>Open a saved row to review its stored result. No new search is run.</p></div>
        <button type="button" className="inv-retry inv-history-refresh" style={{ marginTop: 0 }} onClick={() => q.refetch()} disabled={q.isFetching} data-testid="button-refresh-history">
          <RefreshCw size={14} className={q.isFetching ? 'inv-spin' : ''} /> {q.isFetching ? 'Refreshing' : 'Refresh'}
        </button>
      </div>

      {q.isLoading && (
        <div className="inv-history-card" data-testid="status-history-loading" aria-busy="true">
          {[0, 1, 2, 3].map(i => <div className="inv-skel" key={i} />)}
        </div>
      )}

      {q.isError && !q.data && (
        <div className="inv-error-card" data-testid="status-history-error">
          <span className="inv-state-icon"><CircleAlert size={23} /></span>
          <div className="inv-state-copy"><h3>Saved investigations could not be loaded.</h3><p>Check your connection and try again.</p>
            <button type="button" className="inv-retry" onClick={() => q.refetch()} data-testid="button-retry-history"><RefreshCw size={14} /> Retry</button></div>
        </div>
      )}

      {q.isError && q.data && (
        <div className="inv-history-warn" role="alert" data-testid="status-history-refresh-error">
          <CircleAlert size={14} /> Could not refresh history; showing the last loaded list.
          <button type="button" onClick={() => q.refetch()} data-testid="button-retry-history-inline">Retry</button>
        </div>
      )}

      {q.data && items.length === 0 && (
        <div className="inv-empty-card" data-testid="status-history-empty">
          <span className="inv-state-icon"><History size={23} /></span>
          <div className="inv-state-copy"><h3>{page > 1 ? 'No investigations on this page' : 'No saved investigations yet'}</h3>
            <p>{page > 1 ? 'This page is empty.' : 'Successful URL-only searches from now on are saved here. Searches run before history was introduced were not saved.'}</p>
            {page > 1 && <button type="button" className="inv-retry" onClick={() => onPageChange(1)} data-testid="button-history-first">Back to first page</button>}</div>
        </div>
      )}

      {q.data && items.length > 0 && (
        <div className="inv-history-card">
          <div className="inv-history-scroll">
            <table className="inv-history-table" data-testid="table-investigation-history">
              <thead><tr><th>Artist / reference</th><th>Discovered profiles and verdicts</th><th>Date</th><th><span className="sr-only">Action</span></th></tr></thead>
              <tbody>
                {items.map(item => {
                  const skip = refPlatform(item.knownProfileUrl);
                  const found = item.result.profiles.filter(p => p.platform.toLowerCase() !== skip);
                  const active = item.id === activeId;
                  return (
                    <tr key={item.id} className={active ? 'active' : ''} data-testid={`row-history-${item.id}`}>
                      <td>
                        <strong data-testid={`text-history-subject-${item.id}`}>{item.result.subject || host(item.knownProfileUrl)}</strong>
                        <a className="inv-history-ref" href={item.knownProfileUrl} target="_blank" rel="noopener noreferrer">{host(item.knownProfileUrl)}</a>
                      </td>
                      <td>
                        {found.length === 0 ? <span className="inv-history-none">No other-platform links found</span> : (
                          <ul className="inv-history-links">
                            {found.map((p, i) => (
                              <li key={`${p.url}-${i}`}>
                                <span className="inv-history-plat">{p.platform}</span>
                                <a href={p.url} target="_blank" rel="noopener noreferrer">{host(p.url)} <ArrowUpRight size={11} aria-hidden="true" /></a>
                                <span className={`inv-history-verdict v-${p.jevVerification?.verdict ?? 'none'}`}>{verdictOf(p)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="inv-mono inv-history-date">{new Date(item.result.searchedAt).toLocaleString()}</td>
                      <td>
                        <button type="button" className="inv-retry inv-history-open" style={{ marginTop: 0 }} disabled={disabled} onClick={() => onOpen(item)} data-testid={`button-open-history-${item.id}`}>
                          <FolderOpen size={13} /> {active ? 'Viewing' : 'Review'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="inv-history-pager">
            <span className="inv-mono">Page {page}</span>
            <div>
              <button type="button" className="inv-retry" style={{ marginTop: 0 }} disabled={page <= 1 || q.isFetching} onClick={() => onPageChange(page - 1)} data-testid="button-history-prev"><ChevronLeft size={14} /> Previous</button>
              <button type="button" className="inv-retry" style={{ marginTop: 0 }} disabled={!q.data.hasMore || q.isFetching} onClick={() => onPageChange(page + 1)} data-testid="button-history-next">Next <ChevronRight size={14} /></button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
