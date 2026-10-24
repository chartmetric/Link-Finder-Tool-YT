import { ArrowUpRight, ChevronDown, CircleAlert } from 'lucide-react';
import type { BulkBrandItem } from '@workspace/api-client-react';
import { Candidate, PlatformIcon } from '@/pages/SingleArtist';
import { ProfileUrlAliases } from '@/components/profile-url-aliases';
import { getNetConfidence } from '@/lib/net-confidence';
import { outcomeLabel, shortUrl } from '@/lib/bulk';

export function BrandResult({ item, index }: { item: BulkBrandItem; index: number }) {
  const c = item.candidate;
  const profiles = (item.result?.profiles ?? []).slice().sort((a, b) => (getNetConfidence(b).score ?? -1) - (getNetConfidence(a).score ?? -1) || b.confidence - a.confidence);
  return (
    <article className={`blk-item s-${item.status}`} data-testid={`row-run-item-${c.profileId}`}>
      <header className="blk-item-head">
        <span className="blk-item-idx inv-mono">{String(index + 1).padStart(2, '0')}</span>
        <div className="blk-item-name">
          <h3>{c.profileName}</h3>
          <a href={c.url} target="_blank" rel="noopener noreferrer" className="inv-history-ref"><PlatformIcon platform={c.platform} size={11} /> {shortUrl(c.url)}</a>
          <ProfileUrlAliases profile={item.result?.referenceProfile ? { ...item.result.referenceProfile, url: c.url } : undefined} compact />
        </div>
        <span className="inv-mono blk-tier">T{c.tier}</span>
        <span className={`blk-pill s-${item.status}`} data-testid={`status-item-${c.profileId}`}>{item.status}</span>
      </header>

      {item.error && <div className="inv-save-warn blk-item-err" role="alert"><CircleAlert size={15} /><span><b>Failed:</b> {item.error}</span></div>}

      {item.platforms.length > 0 && (
        <ul className="blk-outcomes">
          {item.platforms.map(o => (
            <li key={o.platform} className={`blk-outcome o-${o.status}`} data-testid={`outcome-${c.profileId}-${o.platform.toLowerCase()}`}>
              <div className="blk-outcome-top"><PlatformIcon platform={o.platform} size={14} /><b>{o.platform}</b><span className={`blk-pill o-${o.status}`}>{outcomeLabel[o.status]}</span></div>
              <p>{o.reason}</p>
              {o.status === 'explicit_unavailable' && o.evidenceUrls.length === 0 && <p className="blk-warn-text">No source was attached to this statement; treat as unverified.</p>}
              {o.evidenceUrls.length > 0 && <div className="blk-evidence">
                <span className="inv-mono">{o.status === 'explicit_unavailable' ? 'First-party source' : 'Evidence'}</span>
                {o.evidenceUrls.map(u => <a key={u} href={u} target="_blank" rel="noopener noreferrer">{shortUrl(u)} <ArrowUpRight size={10} aria-hidden="true" /></a>)}
              </div>}
              <small className="inv-mono">Checked {new Date(o.checkedAt).toLocaleString()}</small>
            </li>
          ))}
        </ul>
      )}
      {item.status === 'queued' && item.platforms.length === 0 && <p className="blk-quiet">Waiting in the server queue.</p>}
      {item.status === 'running' && <p className="blk-quiet">Searching now. Results appear when this brand finishes.</p>}

      {item.result && (
        <details className="inv-alternatives blk-saved">
          <summary data-testid={`button-expand-${c.profileId}`}>{profiles.length} saved {profiles.length === 1 ? 'candidate' : 'candidates'} · est. ${item.result.estimatedCostUsd.toFixed(4)} <ChevronDown size={14} /></summary>
          {item.result.historySaveError && <div className="inv-save-warn" role="alert"><CircleAlert size={15} /><span>{item.result.historySaveError}</span></div>}
          {profiles.length === 0 ? <div className="inv-no-platform">No candidates were saved for this brand.</div> : profiles.map((p, i) => <Candidate key={`${p.url}-${i}`} candidate={p} index={i} />)}
        </details>
      )}
    </article>
  );
}
