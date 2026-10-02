import { CircleAlert, RefreshCw } from 'lucide-react';
import { getGetMusicianCoverageQueryKey, useGetMusicianCoverage } from '@workspace/api-client-react';

type Row = { label: string; profiles: number; llm: number; inv: number };

function Figure({ n, total, zeroNote, testid }: { n: number; total: number; zeroNote: string; testid: string }) {
  return (
    <div className="inv-cov-fig">
      <strong data-testid={testid}>{n.toLocaleString()}</strong>
      <span className="inv-mono">of {total.toLocaleString()} profiles</span>
      {n === 0 && <em>{zeroNote}</em>}
    </div>
  );
}

function Block({ row, big }: { row: Row; big?: boolean }) {
  const key = row.label.toLowerCase().replace(/\W+/g, '-');
  return (
    <div className={`inv-cov-block${big ? ' big' : ''}`} data-testid={`card-coverage-${key}`}>
      <h3>{row.label}<span className="inv-mono">{row.profiles.toLocaleString()} profiles</span></h3>
      <div className="inv-cov-pair">
        <div className="inv-cov-src llm">
          <div className="inv-cov-src-title">Existing LLM enrichment</div>
          <Figure n={row.llm} total={row.profiles} testid={`text-llm-${key}`} zeroNote="No platform links stored in existing enrichment yet." />
        </div>
        <div className="inv-cov-src inv">
          <div className="inv-cov-src-title">This app's investigations</div>
          <Figure n={row.inv} total={row.profiles} testid={`text-investigation-${key}`} zeroNote="No saved investigation with discovered links matches these profiles yet." />
        </div>
      </div>
    </div>
  );
}

export function MusicianCoverage() {
  const q = useGetMusicianCoverage({ query: { queryKey: getGetMusicianCoverageQueryKey(), refetchOnMount: 'always', refetchInterval: 60000 } });
  const data = q.data;
  const busy = q.isFetching;
  const rows: Row[] = data ? [...data.tiers].sort((a, b) => a.tier - b.tier).map(t => ({ label: `Tier ${t.tier}`, profiles: t.profiles, llm: t.withLlmLinks, inv: t.withInvestigationLinks })) : [];

  return (
    <section className="inv-cov" aria-labelledby="coverage-title" data-testid="section-musician-coverage">
      <div className="inv-section-head">
        <div><div className="inv-kicker">03 / Live coverage</div><h2 id="coverage-title">Musician link coverage, tiers 1-3</h2></div>
        <button type="button" className="inv-retry" style={{ marginTop: 0 }} onClick={() => q.refetch()} disabled={busy} data-testid="button-refresh-coverage">
          <RefreshCw size={14} className={busy ? 'inv-spin' : ''} /> Refresh
        </button>
      </div>
      <p className="inv-cov-note">Non-deleted musician profiles, using each profile’s latest global tier. Discovery counts only, not verification or approval. The two sources are counted separately; repeated investigations count the same musician once.</p>

      {q.isLoading && <div className="inv-history-card" data-testid="status-coverage-loading"><div className="inv-skel" /><div className="inv-skel" /></div>}

      {q.isError && !data && (
        <div className="inv-error-card" data-testid="status-coverage-error">
          <span className="inv-state-icon"><CircleAlert size={23} /></span>
          <div className="inv-state-copy"><h3>Coverage could not be loaded.</h3><p>No figures are shown rather than guessing.</p>
            <button type="button" className="inv-retry" onClick={() => q.refetch()} data-testid="button-retry-coverage"><RefreshCw size={14} /> Retry</button></div>
        </div>
      )}

      {data && (
        <>
          {q.isError && <div className="inv-history-warn" role="alert">Latest refresh failed; showing the previous figures.<button type="button" onClick={() => q.refetch()}>Retry</button></div>}
          <Block big row={{ label: 'Tiers 1-3 combined', profiles: data.profiles, llm: data.withLlmLinks, inv: data.withInvestigationLinks }} />
          <div className="inv-cov-tiers">{rows.map(r => <Block key={r.label} row={r} />)}</div>
          <p className="inv-cov-stamp inv-mono" data-testid="text-coverage-generated-at">Generated {new Date(data.generatedAt).toLocaleString()} / refreshes every 60s</p>
        </>
      )}
    </section>
  );
}
