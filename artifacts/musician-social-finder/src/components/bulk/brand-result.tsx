import { ChevronDown, CircleAlert } from 'lucide-react';
import type { BulkBrandItem } from '@workspace/api-client-react';
import { Candidate, PlatformIcon } from '@/pages/SingleArtist';
import { ProfileUrlAliases } from '@/components/profile-url-aliases';
import { getNetConfidence } from '@/lib/net-confidence';
import { KIND_META, kindOf, shortUrl } from '@/lib/bulk';
import { platformSearchStatus, profileSearchStatus } from '@/lib/bulk-result-status';
import { EvidenceLinks } from './evidence-links';

export function BrandResult({ item, index }: { item: BulkBrandItem; index: number }) {
  const c = item.candidate;
  const status = profileSearchStatus(item);
  const evidenceAccounts = [
    ...(item.result?.profiles ?? []),
    ...(item.result?.referenceProfile ? [item.result.referenceProfile] : []),
  ];
  const profiles = (item.result?.profiles ?? []).slice().sort((a, b) => (getNetConfidence(b).score ?? -1) - (getNetConfidence(a).score ?? -1) || b.confidence - a.confidence);
  return (
    <article className={`blk-item s-${status.tone}`} data-testid={`row-run-item-${c.profileId}`}>
      <header className="blk-item-head">
        <span className="blk-item-idx inv-mono">{String(index + 1).padStart(2, '0')}</span>
        <div className="blk-item-name">
          <h3>{c.profileName}</h3>
          <a href={c.url} target="_blank" rel="noopener noreferrer" className="inv-history-ref"><PlatformIcon platform={c.platform} size={11} /> {shortUrl(c.url)}</a>
          <ProfileUrlAliases profile={item.result?.referenceProfile ? { ...item.result.referenceProfile, url: c.url } : undefined} compact />
        </div>
        <span className={`blk-kind k-${kindOf(c)}`} data-testid={`badge-type-${c.profileId}`}>{KIND_META[kindOf(c)].label}</span>
        <span className="inv-mono blk-tier">{c.tier == null ? 'Unranked' : `T${c.tier}`}</span>
        <span className={`blk-pill s-${status.tone}`} title={status.description} data-testid={`status-item-${c.profileId}`}>{status.label}</span>
      </header>
      {item.status === 'completed' && <p className="blk-result-explanation" data-testid={`explanation-item-${c.profileId}`}>{status.description}</p>}

      {item.error && <div className="inv-save-warn blk-item-err" role="alert"><CircleAlert size={15} /><span><b>Failed:</b> {item.error}</span></div>}

      {item.platforms.length > 0 && (
        <ul className="blk-outcomes">
          {item.platforms.map(o => {
            const platformStatus = platformSearchStatus(o);
            return (
            <li key={o.platform} className={`blk-outcome o-${o.status}`} data-testid={`outcome-${c.profileId}-${o.platform.toLowerCase()}`}>
              <div className="blk-outcome-top"><PlatformIcon platform={o.platform} size={14} /><b>{o.platform}</b><span className={`blk-pill o-${platformStatus.tone}`}>{platformStatus.label}</span></div>
              {['incomplete', 'not_found', 'explicit_unavailable'].includes(o.status) && <p className="blk-outcome-explanation">{platformStatus.description}</p>}
              <details className="blk-outcome-details">
                <summary aria-label={`${o.platform} evidence and details`} data-testid={`details-${c.profileId}-${o.platform.toLowerCase()}`}>
                  <span>Evidence &amp; details{o.evidenceUrls.length > 0 ? ` · ${new Set(o.evidenceUrls).size} ${new Set(o.evidenceUrls).size === 1 ? 'link' : 'links'}` : ''}</span>
                  <ChevronDown size={12} aria-hidden="true" />
                </summary>
                <div className="blk-outcome-body">
                  <p>{o.reason}</p>
                  <EvidenceLinks outcome={o} accounts={evidenceAccounts} />
                  <small className="inv-mono">Checked {new Date(o.checkedAt).toLocaleString()}</small>
                </div>
              </details>
            </li>
          ); })}
        </ul>
      )}
      {item.status === 'queued' && item.platforms.length === 0 && <p className="blk-quiet">Waiting in the server queue.</p>}
      {item.status === 'running' && <p className="blk-quiet">Searching now. Results appear when this profile finishes.</p>}

      {item.result && (
        <details className="inv-alternatives blk-saved">
          <summary data-testid={`button-expand-${c.profileId}`}>{profiles.length} saved {profiles.length === 1 ? 'candidate' : 'candidates'} · est. ${item.result.estimatedCostUsd.toFixed(4)} <ChevronDown size={14} /></summary>
          {item.result.historySaveError && <div className="inv-save-warn" role="alert"><CircleAlert size={15} /><span>{item.result.historySaveError}</span></div>}
          {profiles.length === 0 ? <div className="inv-no-platform">No candidates were saved for this profile.</div> : profiles.map((p, i) => <Candidate key={`${p.url}-${i}`} candidate={p} index={i} />)}
        </details>
      )}
    </article>
  );
}
