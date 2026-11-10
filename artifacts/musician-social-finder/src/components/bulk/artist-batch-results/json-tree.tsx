import { useState } from 'react';

function Leaf({ v }: { v: unknown }) {
  if (v === null) return <span className="abr-empty">null</span>;
  if (v === '') return <span className="abr-empty">(empty string)</span>;
  if (typeof v === 'string' && /^https?:\/\//i.test(v)) return <a href={v} target="_blank" rel="noreferrer noopener">{v}</a>;
  return <span>{String(v)}</span>;
}

export function JsonTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || typeof value !== 'object') return <Leaf v={value} />;
  const entries = Array.isArray(value) ? value.map((v, i) => [`[${i}]`, v] as const) : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="abr-empty">{Array.isArray(value) ? 'empty list' : 'empty object'}</span>;
  return (
    <dl className="abr-tree">
      {entries.map(([k, v]) => (
        <div key={k} className="abr-tree-row">
          <dt className="inv-mono">{k}</dt>
          <dd>{v !== null && typeof v === 'object' && depth >= 1
            ? <details className="abr-sub"><summary>{Array.isArray(v) ? `${v.length} items` : `${Object.keys(v).length} keys`}</summary><JsonTree value={v} depth={depth + 1} /></details>
            : <JsonTree value={v} depth={depth + 1} />}</dd>
        </div>
      ))}
    </dl>
  );
}

export function JsonValue({ raw, parsed }: { raw: string; parsed: unknown }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="abr-json">
      <button type="button" className="abr-mini-btn" aria-pressed={showRaw} onClick={() => setShowRaw(s => !s)}>{showRaw ? 'Show readable view' : 'Show raw JSON'}</button>
      {showRaw ? <pre className="abr-pre inv-mono">{JSON.stringify(parsed, null, 2)}</pre> : <JsonTree value={parsed} />}
      {showRaw && raw !== JSON.stringify(parsed, null, 2) && <p className="abr-hint">Pretty-printed; the original string is in the CSV download.</p>}
    </div>
  );
}
