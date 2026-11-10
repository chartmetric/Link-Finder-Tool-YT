import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { isValidElement, type ReactNode, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ArtistResultBatch } from '@workspace/api-client-react';
import { BatchPicker, BatchSummary } from '../src/components/bulk/artist-batch-results/batch-picker';

// Standalone tsx uses the source app's JSX-preserve config (classic JSX),
// whereas Vite supplies the automatic React runtime in the application.
Object.assign(globalThis, { React });

const id = (suffix: string) => `saved-alternatives-${'a'.repeat(24)}-${suffix.repeat(16)}`;
const checkpoint: ArtistResultBatch = {
  id: id('c'), title: 'Saved alternatives', source: 'diagnostic',
  createdAt: '2026-11-10T10:00:00.000Z', status: 'interrupted_checkpoint',
  artistCount: 1, candidateCount: 1, rowCount: 1, verifiedCount: 0, reviewCount: 0,
  notInspectedCount: 1, metadataFailedCount: 0, noCandidateCount: 0,
  reservedUsd: 0.02, reportedUsd: null, explanation: 'Read only.',
  metrics: [
    { label: 'Parent budget identity', value: 'approved-parent' },
    { label: 'Spending observation', value: 'Last durable parent snapshot; journal may be newer. No resume authorized.' },
    { label: 'Run date source', value: 'First journal event' },
  ],
};
const final: ArtistResultBatch = {
  ...checkpoint, id: id('f'), status: 'stopped',
  metrics: [
    { label: 'Parent budget identity', value: 'approved-parent' },
    { label: 'Spending observation', value: 'Final saved parent snapshot, not an invoice' },
  ],
};
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return isValidElement<Record<string, unknown>>(node)
    ? [node, ...elements(node.props.children as ReactNode)] : [];
}

test('final navigation selects the exact archive and keeps the checkpoint selectable', () => {
  const selections: string[] = [];
  const tree = BatchPicker({ batches: [checkpoint, final], selected: checkpoint.id, onSelect: id => selections.push(id) });
  const controls = elements(tree);
  const finalButton = controls.find(e => e.props['data-testid'] === `button-final-observation-${final.id}`);
  assert.ok(finalButton);
  assert.equal(finalButton.props.type, 'button');
  assert.equal(typeof finalButton.props.onClick, 'function');
  (finalButton.props.onClick as () => void)();
  assert.deepEqual(selections, [final.id]);
  const radios = controls.filter(e => e.props.role === 'radio');
  assert.equal(radios.length, 2);
  assert.equal(radios[0].props['aria-checked'], true);
  assert.equal(radios[1].props['aria-checked'], false);
  const back = elements(BatchPicker({ batches: [checkpoint, final], selected: final.id, onSelect: id => selections.push(id) }))
    .find(e => e.props['data-testid'] === `button-batch-${checkpoint.id}`)!;
  (back.props.onClick as () => void)();
  assert.deepEqual(selections, [final.id, checkpoint.id]);
});

test('provenance and shared-budget caveats remain visible without opening details', () => {
  const html = renderToStaticMarkup(<><BatchPicker batches={[checkpoint, final]} selected={checkpoint.id} onSelect={() => {}} /><BatchSummary b={checkpoint} /></>);
  for (const text of ['2 saved observations', 'approved-parent', 'Interrupted / durable checkpoint',
    'Final saved summary', 'spending is not additive', 'does not replace this evidence',
    'journal may be newer', 'First journal event', 'Not an observation sequence or import time', checkpoint.id]) {
    assert.ok(html.includes(text), `Missing visible provenance: ${text}`);
  }
});

test('missing or unrelated finals do not offer navigation or imply retry permission', () => {
  const unrelated = { ...final, metrics: [{ label: 'Parent budget identity', value: 'another-parent' },
    { label: 'Spending observation', value: 'Final saved parent snapshot, not an invoice' }] };
  const html = renderToStaticMarkup(<BatchPicker batches={[checkpoint, unrelated]} selected={checkpoint.id} onSelect={() => {}} />);
  assert.doesNotMatch(html, /button-final-observation-/);
  assert.match(html, /No final saved observation for this run is in the loaded history/);
  assert.match(html, /does not authorize a retry/);
});
