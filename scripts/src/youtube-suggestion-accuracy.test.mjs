import test from 'node:test';
import assert from 'node:assert/strict';
import {accuracyMetrics, parseCsv, renderReport} from './youtube-suggestion-accuracy.mjs';

test('BOM, quotes, embedded newline and escaped quotation marks survive CSV parsing', () => {
  assert.deepEqual(parseCsv('\uFEFF"artist","note"\r\n"Br@m","a,\n""b"""\r\n'),
    [{artist: 'Br@m', note: 'a,\n"b"'}]);
  assert.throws(() => parseCsv('"artist"\n"missing end'));
});
test('unsure and unreviewed are not correct, wrong or binary precision denominators', () => {
  const m = accuracyMetrics(['correct', 'wrong', 'unsure', 'unreviewed'].map(review_label => ({review_label})));
  assert.equal(m.reviewedScorablePrecision, .5);
  assert.equal(m.reviewed, 3);
  assert.equal(m.unscorable, 1);
  assert.equal(m.unreviewed, 1);
  assert.equal(m.confirmedShareOfAllSuggestions, .25);
  assert.deepEqual(m.allSuggestionPrecisionBounds, [.25, .75]);
  assert.equal(m.fullSetTargetEstablished, false);
});
test('no binary grades means unknown precision, not zero or perfect', () => {
  assert.equal(accuracyMetrics([{review_label: 'unsure'}]).reviewedScorablePrecision, null);
  assert.equal(accuracyMetrics([]).confirmedShareOfAllSuggestions, null);
});
test('a perfect tiny scorable subset cannot establish the full-set target', () => {
  const m = accuracyMetrics(['correct', 'unsure', 'unsure'].map(review_label => ({review_label})));
  assert.equal(m.meets65AmongScorable, true);
  assert.equal(m.fullSetTargetEstablished, false);
});
test('65% is inclusive and unknown labels fail explicitly', () => {
  assert.equal(accuracyMetrics(Array.from({length: 20}, (_, i) =>
    ({review_label: i < 13 ? 'correct' : 'wrong'}))).meets65AmongScorable, true);
  assert.throws(() => accuracyMetrics([{review_label: 'model_supported'}]));
});
test('the self-contained report separates precision denominators and supports both color modes', () => {
  const m = accuracyMetrics([]);
  const html = renderReport({all: m, topic: m, artistFacing: m}, [], []);
  assert.ok(html.includes('not an estimate that only 5.2%'));
  assert.ok(html.includes('not human review'));
  assert.ok(html.includes('color-scheme:light dark'));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<link'));
});
