import { ChevronDown, ExternalLink } from 'lucide-react';
import type { ArtistResultRow } from '@workspace/api-client-react';
import { fmtScore, statusTone, inspectionNotes } from './model';
import { RowDetail } from './row-detail';

function UrlCell({ kind, url, platform }: { kind: 'Verified' | 'Candidate'; url: string | null; platform: string }) {
  return (
    <div className={`abr-url k-${kind.toLowerCase()}`}>
      <span className="abr-url-k">{kind} {platform}</span>
      {url ? <a href={url} target="_blank" rel="noreferrer noopener" data-testid={`link-${kind.toLowerCase()}-url`}>{url.replace(/^https?:\/\/(www\.)?/, '')}<ExternalLink size={11} aria-hidden /></a>
        : <span className="abr-empty">{kind === 'Verified' ? 'None verified' : 'No candidate'}</span>}
    </div>
  );
}

export function ResultRow({ row, open, onToggle, platform = 'Instagram' }: { row: ArtistResultRow; open: boolean; onToggle: () => void; platform?: string }) {
  const topic = platform === 'YouTube' && row.fields.some(f => f.label === 'YouTube channel type' && f.value === 'topic');
  const topicStatus = row.fields.find(f => f.label === 'Topic identity status')?.value;
  return (
    <li className={`abr-row tone-${statusTone(row.status)}`} data-testid={`row-artist-result-${row.id}`}>
      <div className="abr-row-main">
        <div className="abr-who">
          <h3>{row.artistName || <span className="abr-empty">Unnamed artist</span>}</h3>
          {topic && <span className="abr-status tone-neutral" data-testid="badge-topic-channel">Topic — auto-generated</span>}
          <span className="inv-mono abr-sub-id">profile {row.profileId || 'blank'}{row.comparisonType ? ` · ${row.comparisonType}` : ''}</span>
        </div>
        {platform === 'YouTube' ? <div className="abr-url"><span className="abr-url-k">{topic ? 'Supported Topic suggestion' : 'Likely YouTube suggestion'}</span>
          {row.status === 'likely' && row.candidateUrl ? <a href={row.candidateUrl} target="_blank" rel="noreferrer noopener">{row.candidateUrl}</a>
            : <span className="abr-empty">None currently suggested</span>}</div> : <UrlCell kind="Verified" url={row.verifiedUrl} platform={platform} />}
        <UrlCell kind="Candidate" url={row.candidateUrl} platform={platform} />
        <div className="abr-dec">
          <b className={`abr-status tone-${statusTone(row.status)}`}>{row.status === 'metadata_failed' ? 'metadata unavailable' : row.status === 'positive_review_suggestion' ? 'positive suggestion · review only' : row.status.replace(/_/g, ' ')}</b>
          {topic ? <span>Auto-generated music catalog, not an artist-managed channel. {topicStatus}</span>
            : inspectionNotes[row.status] && <span>{inspectionNotes[row.status]}</span>}
          <span className="inv-mono" title="Uncalibrated model identity score, not a probability">score {fmtScore(row.score)}</span>
          {row.verdict && <span className="abr-verdict">{row.verdict}</span>}
        </div>
        <button type="button" className="abr-expand" aria-expanded={open} aria-controls={`abr-detail-${row.id}`} onClick={onToggle} data-testid={`button-expand-row-${row.id}`}>
          {open ? 'Hide' : 'All fields'} <ChevronDown size={13} aria-hidden />
        </button>
      </div>
      {open && <RowDetail row={row} />}
    </li>
  );
}
