import { ArrowUpRight } from 'lucide-react';
import type { BulkPlatformOutcome } from '@workspace/api-client-react';
import { shortUrl } from '../../lib/bulk';
import { groupEvidenceUrls, type EvidenceAccount } from '../../lib/evidence-urls';

export function EvidenceLinks({ outcome, accounts }: { outcome: BulkPlatformOutcome; accounts: EvidenceAccount[] }) {
  if (!outcome.evidenceUrls.length) return null;
  const groups = groupEvidenceUrls(outcome.evidenceUrls, accounts);
  return (
    <div className="blk-evidence">
      <span className="inv-mono">{outcome.status === 'explicit_unavailable' ? 'First-party source' : 'Evidence'}</span>
      {groups.map(group => {
        const aliases = group.confirmedAccount && group.urls.length > 1;
        return (
          <div key={group.urls[0]} className={`blk-evidence-group${aliases ? ' is-alias' : ''}`}>
            {aliases && <strong className="blk-alias-heading" data-testid="evidence-account-aliases">
              1 account · {group.urls.length} URL aliases
            </strong>}
            {group.urls.map(url => <a key={url} href={url} target="_blank" rel="noopener noreferrer">
              {shortUrl(url)} <ArrowUpRight size={10} aria-hidden="true" />
            </a>)}
            {aliases && <small>Same account confirmed · identity match assessed separately.</small>}
          </div>
        );
      })}
    </div>
  );
}
