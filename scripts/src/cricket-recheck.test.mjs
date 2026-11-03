import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRecheckPlayers, requireSerper } from './cricket-recheck.mjs';

const player = { provider: 'sportmonks', provider_player_id: 17, name: 'Test Player' };
const row = (status = 'completed_candidates', provider = 'sportmonks') => ({
  run_id: 'original', latest: [status, JSON.stringify({ ...player, provider }),
    JSON.stringify({ profiles: [{ url: 'https://www.instagram.com/testplayer/' }] }), ''],
});
test('rechecks deduplicate exact provider identities and keep prior evidence without reusing paid outcomes', () => {
  const players = buildRecheckPlayers([row(), { ...row(), run_id: 'second' }, row('completed_no_candidates', 'other')], [
    { player, result: { profiles: [{ url: 'https://instagram.com/other-suggestion' }] } },
  ]);
  assert.equal(players.length, 2);
  assert.deepEqual(players[0].priorDiscovery.runIds, ['original', 'second', 'original-10-player-pilot']);
  assert.equal(players[0].priorDiscovery.candidateUrls.length, 2);
  assert.throws(() => buildRecheckPlayers([row('running')]), /unfinished/);
  assert.throws(() => buildRecheckPlayers([row('queued')]), /unfinished/);
});
test('Gemini-only, failed, missing and unavailable Serper results never satisfy the required search', () => {
  for (const result of [{}, { methodsUsed: [{ method: 'gemini', status: 'used' }] },
    { methodsUsed: [{ method: 'serper', status: 'failed' }] },
    { methodsUsed: [{ method: 'serper', status: 'unavailable' }] }]) {
    assert.throws(() => requireSerper(result, player), /Required Serper/);
  }
});
test('fresh Serper evidence can corroborate a prior URL but never claims identity verification or absence', () => {
  const selected = buildRecheckPlayers([row()])[0];
  const methodsUsed = [{ method: 'serper', status: 'used' }];
  const evidence = requireSerper({ methodsUsed, profiles: [{ url: 'https://instagram.com/TESTPLAYER' }] }, selected);
  assert.equal(evidence.previouslySuggestedUrlsFoundAgain.length, 1);
  assert.equal(evidence.identityVerified, false);
  assert.equal(requireSerper({ methodsUsed, profiles: [{ url: 'https://other.example/testplayer' }] }, selected)
    .previouslySuggestedUrlsFoundAgain.length, 0);
  assert.match(requireSerper({ methodsUsed, profiles: [] }, selected).note, /not proof of account absence/);
});
test('the paid worker always requests Serper, stops on the first failure and never reuses Gemini-only pilot results', () => {
  const source = readFileSync(new URL('./cricket-instagram.mjs', import.meta.url), 'utf8');
  assert.match(source, /targetPlatforms: \['instagram'\], methods: \['serper'\]/);
  assert.match(source, /requireSerper\(result, player\)/);
  assert.match(source, /if \(stopped\) \{[\s\S]*event\(id, player, 'queued'\)/);
  assert.match(source, /row\.result\.methodsUsed\?\.some\(method => method\.method === 'serper'/);
  assert.doesNotMatch(source, /methods: \['gemini'\]/);
});
