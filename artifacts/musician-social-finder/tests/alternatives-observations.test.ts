import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArtistResultBatch } from '@workspace/api-client-react';
import { alternativesObservation, groupObservations } from '../src/components/bulk/artist-batch-results/alternatives-observations';

const scope = 'a'.repeat(24);
function batch(checkpoint: string, overrides: Partial<ArtistResultBatch> = {}): ArtistResultBatch {
  return {
    id: `saved-alternatives-${scope}-${checkpoint.repeat(16)}`,
    title: 'Saved alternatives · 2 artists', source: 'diagnostic',
    createdAt: '2026-11-10T10:00:00.000Z', status: 'interrupted_checkpoint',
    artistCount: 2, candidateCount: 3, rowCount: 3, verifiedCount: 0, reviewCount: 0,
    notInspectedCount: 3, metadataFailedCount: 0, noCandidateCount: 0,
    reservedUsd: 0.04, reportedUsd: null, explanation: 'Review only.',
    metrics: [
      { label: 'Parent budget identity', value: 'approved-parent' },
      { label: 'Spending observation', value: 'Last durable parent snapshot; journal may be newer. Unjournaled reservations are unknown. No resume authorized.' },
    ],
    ...overrides,
  };
}
const final = () => batch('b', {
  status: 'stopped',
  metrics: [
    { label: 'Parent budget identity', value: 'approved-parent' },
    { label: 'Spending observation', value: 'Final saved parent snapshot, not an invoice' },
  ],
});

test('groups checkpoints and final snapshots without merging or mutating evidence', () => {
  const checkpoint = batch('c'), later = final(), unrelated = batch('d', { id: 'live-other', source: 'live' });
  const input = [checkpoint, unrelated, later], before = JSON.stringify(input);
  const groups = groupObservations(input);
  assert.deepEqual(groups.map(g => g.batches.map(b => b.id)), [[checkpoint.id, later.id], [unrelated.id]]);
  assert.equal(groups[0].batches[0], checkpoint);
  assert.equal(groups[0].batches[1], later);
  assert.equal(JSON.stringify(input), before);
  assert.equal(alternativesObservation(checkpoint)?.kind, 'checkpoint');
  assert.equal(alternativesObservation(later)?.kind, 'final');
  assert.equal(checkpoint.createdAt, later.createdAt, 'shared dispatch dates must not collapse observations');
});

test('same title, budget, or date alone cannot join different scopes or parents', () => {
  const original = batch('c');
  const otherScope = batch('d', { id: `saved-alternatives-${'e'.repeat(24)}-${'d'.repeat(16)}` });
  const otherParent = batch('f', { metrics: [{ label: 'Parent budget identity', value: 'other-parent' }] });
  assert.equal(groupObservations([original, otherScope, otherParent]).length, 3);
});

test('legacy, missing and malformed identities stay selectable but ungrouped', () => {
  const missing = batch('c', { metrics: [] }), missingToo = batch('d', { metrics: [] });
  const legacy = batch('e', { id: `saved-alternatives-${scope}` });
  assert.equal(groupObservations([missing, missingToo, legacy]).length, 3);
  assert.equal(alternativesObservation(missing)?.runKey, null);
  assert.equal(alternativesObservation(legacy), null);
  assert.equal(alternativesObservation(batch('f', { source: 'research' })), null);
});

test('finality comes from provenance, never status or date sorting', () => {
  assert.equal(alternativesObservation(batch('c', { status: 'completed' }))?.kind, 'checkpoint');
  assert.equal(alternativesObservation(final())?.kind, 'final', 'a stopped final is still a final observation');
  assert.equal(alternativesObservation(batch('d', { status: 'completed', metrics: [] }))?.kind, 'unknown');
  const completed = final(), checkpoint = batch('c');
  assert.deepEqual(groupObservations([completed, checkpoint])[0].batches, [completed, checkpoint]);
});
