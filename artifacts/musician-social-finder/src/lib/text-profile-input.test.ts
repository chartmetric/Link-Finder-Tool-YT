// Run: node --experimental-strip-types --test src/lib/text-profile-input.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTextProfileInput } from './text-profile-input.ts';

test('role: name: platform link', () => {
  const r = parseTextProfileInput('cricketer: virat kohli: instagram link');
  assert.deepEqual(r, { ok: true, name: 'virat kohli', context: 'cricketer', subject: 'virat kohli, cricketer', targetPlatforms: ['instagram'] });
});
test('plain name searches all platforms', () => {
  const r = parseTextProfileInput('  Virat   Kohli ');
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.subject, 'Virat Kohli'); assert.equal(r.targetPlatforms, undefined); }
});
test('case-insensitive platforms', () => {
  const t = parseTextProfileInput('Name Here: TIKTOK');
  const y = parseTextProfileInput('Name Here: YouTube channel');
  assert.ok(t.ok && t.targetPlatforms?.[0] === 'tiktok');
  assert.ok(y.ok && y.targetPlatforms?.[0] === 'youtube');
});
test('all platforms by omission keyword', () => {
  const r = parseTextProfileInput('virat kohli: all platforms');
  assert.ok(r.ok && r.targetPlatforms === undefined);
});
test('rejects unsupported explicit platform', () => {
  const r = parseTextProfileInput('cricketer: virat kohli: facebook link');
  assert.equal(r.ok, false);
});
test('bare platform is not a person', () => {
  assert.equal(parseTextProfileInput('Instagram').ok, false);
  assert.equal(parseTextProfileInput('instagram link').ok, false);
});
test('empty and too long', () => {
  assert.equal(parseTextProfileInput('   ').ok, false);
  assert.equal(parseTextProfileInput('a'.repeat(121)).ok, false);
});

test('rejects unknown explicit target segment', () => {
  assert.equal(parseTextProfileInput('cricketer: Virat Kohli: ESPN link').ok, false);
  assert.equal(parseTextProfileInput('cricketer: Virat Kohli: ESPN').ok, false);
  assert.equal(parseTextProfileInput('Virat Kohli: ESPN link').ok, false);
});
test('role: name stays valid', () => {
  const r = parseTextProfileInput('cricketer: Virat Kohli');
  assert.ok(r.ok && r.name === 'Virat Kohli' && r.context === 'cricketer' && r.targetPlatforms === undefined);
});
