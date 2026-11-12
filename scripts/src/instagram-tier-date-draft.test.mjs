import test from 'node:test';
import assert from 'node:assert/strict';
import {latestGlobalTierObservationSql, assessTierObservation}
  from './instagram-tier-date-draft.mjs';

const options = {now: '2026-11-12T00:19:03Z', maximumAgeSeconds: 129600};
const row = (stamp = '2026-11-11 01:30:22', tier = 2) =>
  ({profile_id: '123', latest: [tier, 7, stamp]});

test('fresh per-artist assignment passes without requiring the newest global date', () => {
  const result = assessTierObservation(row('2026-11-10 13:00:00'), options);
  assert.equal(result.tierCheckPassed, true);
  assert.equal(result.tier, 2);
  assert.equal(Object.hasOwn(result, 'eligible'), false);
});
test('the investigated previous-day assignment remains stale, not eligible', () => {
  assert.equal(assessTierObservation(row('2026-11-10 01:30:15'), options).reason,
    'stale_global_tier');
});
test('age boundary is inclusive; one millisecond older is held', () => {
  const boundary = '2026-11-10T12:19:03Z';
  assert.equal(assessTierObservation(row(boundary), options).tierCheckPassed, true);
  assert.equal(assessTierObservation(row(boundary), {...options,
    now: '2026-11-12T00:19:03.001Z'}).tierCheckPassed, false);
});
test('missing, invalid and future timestamps fail closed', () => {
  assert.equal(assessTierObservation(null, options).reason, 'missing_global_tier');
  for (const stamp of ['', '2026-11-11T01:00:00', '2026-02-30T00:00:00Z',
    '2026-11-11T01:00:00-08:00'])
    assert.equal(assessTierObservation(row(stamp), options).reason, 'invalid_tier_timestamp');
  assert.equal(assessTierObservation(row('2026-11-13 00:00:00'), options).reason,
    'future_tier_timestamp');
});
test('demotions, malformed tiers and missing tuple do not pass', () => {
  for (const tier of [0, 6, 10])
    assert.equal(assessTierObservation(row(undefined, tier), options).reason,
      'outside_tiers_1_to_5');
  for (const tier of ['2', NaN, 2.5])
    assert.equal(assessTierObservation(row(undefined, tier), options).tierCheckPassed, false);
  assert.equal(assessTierObservation({}, options).tierCheckPassed, false);
});
test('explicit bounded policy and UTC clock are mandatory', () => {
  for (const maximumAgeSeconds of [undefined, 0, -1, 129601, Infinity])
    assert.throws(() => assessTierObservation(row(), {...options, maximumAgeSeconds}));
  assert.throws(() => assessTierObservation(row(), {...options, now: undefined}));
});
test('query is selected-ID bounded, global only, with no pre-filtered tier/date', () => {
  const sql = latestGlobalTierObservationSql(['123', '456']);
  assert.match(sql, /^SELECT/);
  assert.match(sql, /profile_type='musician' AND grain='global'/);
  assert.match(sql, /profile IN \(123,456\)/);
  assert.match(sql, /argMax\(tuple\(tier,tier_rank,toString\(computed_at,'UTC'\)\)/);
  assert.doesNotMatch(sql, /max\(computed_at\)|HAVING|tier BETWEEN|computed_at\s*[=<>]|SETTINGS/);
  for (const ids of [[], ['1; DROP'], ['1', '1'], [1], ['0']])
    assert.throws(() => latestGlobalTierObservationSql(ids));
});
