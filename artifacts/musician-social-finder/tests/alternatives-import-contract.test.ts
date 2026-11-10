import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSavedAlternativesDocument } from '../../../scripts/src/import-saved-alternatives.mjs';
import { ListArtistResultBatchesResponse, GetArtistResultRowsResponse } from '../../../lib/api-zod/src/generated/api';
import { alternativesObservation, groupObservations } from '../src/components/bulk/artist-batch-results/alternatives-observations';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('offline importer metadata survives API validation and wording changes in the picker', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'alternatives-contract-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const write = (name: string, value: unknown) => fs.writeFile(path.join(directory, name), JSON.stringify(value));
  const scope = {
    authorization: { approved: true, candidateMetadataFetchesApproved: true, budgetId: 'contract-parent', maxSpendCents: 20 },
    inspectSavedAlternatives: false,
    targets: [{ profileId: '1', artist: 'Contract artist', candidates: [], player: { savedCandidateUrls: [] } }],
  };
  const scopeSha256 = digest(scope);
  const checkpoint = {
    status: 'completed',
    artists: [{ profileId: '1', artist: 'Contract artist', candidates: [], status: 'no_saved_candidate',
      liveLinkAccepted: false, verified: false }],
    budget: { budgetId: 'contract-parent', scopeSha256, maximumSpendCents: 20, reservedCents: 2 },
  };
  await write('scope.json', { scope, scopeSha256 });
  await fs.writeFile(path.join(directory, 'admissions.jsonl'), '');
  await write('outcomes.jsonl', checkpoint);
  const first = await buildSavedAlternativesDocument(directory);
  const final = { ...checkpoint, status: 'stopped', budget: { ...checkpoint.budget, reservedCents: 4 } };
  await write('outcomes.jsonl', final);
  await write('summary.json', final);
  const last = await buildSavedAlternativesDocument(directory);
  assert.deepEqual(first.batch.observation, {
    scopeIdentity: scopeSha256.slice(0, 24), parentBudgetId: 'contract-parent',
    checkpointIdentity: digest(checkpoint).slice(0, 16), kind: 'checkpoint',
  });
  assert.deepEqual(last.batch.observation, {
    ...first.batch.observation, checkpointIdentity: digest(final).slice(0, 16), kind: 'final',
  });
  const original = JSON.stringify([first, last]);
  // The real API validators must preserve metadata on both list and detail.
  const parsed = ListArtistResultBatchesResponse.parse({ batches: [first.batch, last.batch], warnings: [] });
  const detail = GetArtistResultRowsResponse.parse({ ...last, total: last.rows.length, nextOffset: null });
  assert.deepEqual(detail.batch.observation, last.batch.observation);
  const renamed = parsed.batches.map(b => ({
    ...b, title: 'Reworded archive title',
    metrics: b.metrics?.map(m => ({ label: `Renamed ${m.label}`, value: `Reworded ${m.value}` })),
  }));
  const groups = groupObservations(renamed);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].batches, renamed);
  assert.equal(alternativesObservation(renamed[0])?.kind, 'checkpoint');
  assert.equal(alternativesObservation(renamed[1])?.kind, 'final');
  assert.deepEqual(groups[0].batches.map(b => b.reservedUsd), [0.02, 0.04], 'never sum snapshot spending');
  assert.equal(JSON.stringify([first, last]), original, 'original documents remain untouched');
  assert.equal(await fs.readFile(path.join(directory, 'summary.json'), 'utf8'), JSON.stringify(final));

  const legacy = { ...first.batch };
  delete legacy.observation;
  const legacyParsed = ListArtistResultBatchesResponse.parse({ batches: [legacy], warnings: [] }).batches[0];
  assert.equal(groupObservations([legacyParsed, renamed[1]]).length, 1, 'mixed generations retain the same run key');
  assert.equal(alternativesObservation(legacyParsed)?.kind, 'checkpoint');
  for (const observation of [
    { ...last.batch.observation, kind: 'unknown' },
    { ...last.batch.observation, parentBudgetId: ' ' },
    { ...last.batch.observation, scopeIdentity: 'bad' },
    { ...last.batch.observation, checkpointIdentity: '' },
    { kind: 'final' },
  ]) {
    const invalid = { ...last.batch, observation };
    assert.equal(ListArtistResultBatchesResponse.safeParse({ batches: [invalid], warnings: [] }).success, false);
    assert.equal(GetArtistResultRowsResponse.safeParse({ batch: invalid, rows: [], total: 0, nextOffset: null }).success, false);
  }
});
