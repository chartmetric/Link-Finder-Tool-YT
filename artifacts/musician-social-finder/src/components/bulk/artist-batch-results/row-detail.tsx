import type { ArtistResultRow } from '@workspace/api-client-react';
import { GROUPS, fieldTags, isUrl, tryJson } from './model';
import { JsonValue } from './json-tree';

export function RowDetail({ row }: { row: ArtistResultRow }) {
  return (
    <div className="abr-detail" id={`abr-detail-${row.id}`} data-testid={`detail-artist-row-${row.id}`}>
      <p className="abr-hint">All {row.fields.length} original CSV fields for this row, grouped. Blank values are shown, never hidden.</p>
      {GROUPS.map(g => {
        const fields = row.fields.filter(f => f.group === g.key);
        return (
          <details key={g.key} className="abr-group" open={g.key === 'decision'}>
            <summary><span>{g.label}</span><em className="inv-mono">{fields.length} fields</em></summary>
            <p className="abr-hint">{g.note}</p>
            {fields.length === 0 ? <p className="abr-empty">No original columns in this group.</p> : (
              <dl className="abr-fields">
                {fields.map((f, i) => {
                  const parsed = tryJson(f.value); const tags = fieldTags(f);
                  return (
                    <div key={`${f.label}-${i}`} className="abr-field" data-testid={`field-${row.id}-${g.key}-${i}`}>
                      <dt>
                        <span className="inv-mono">{f.label || '(unnamed column)'}</span>
                        {tags.map(t => <b key={t.text} className={`abr-tag t-${t.tone}`}>{t.text}</b>)}
                      </dt>
                      <dd>
                        {f.value.trim() === '' ? <span className="abr-empty">Blank in source CSV</span>
                          : parsed !== undefined ? <JsonValue raw={f.value} parsed={parsed} />
                          : isUrl(f.value) ? <a href={f.value.trim()} target="_blank" rel="noreferrer noopener">{f.value}</a>
                          : f.value.length > 280 ? <details className="abr-sub"><summary>{f.value.slice(0, 120)}…</summary><p className="abr-long">{f.value}</p></details>
                          : <span className="abr-val">{f.value}</span>}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </details>
        );
      })}
    </div>
  );
}
