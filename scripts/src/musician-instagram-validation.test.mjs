import test from 'node:test';
import assert from 'node:assert/strict';
import { validationQueries, directInstagramProfile } from './musician-instagram-validation.mjs';

test('blind queries do not include the supplied positive handle', () => {
  const queries = validationQueries('Shenge wasehlalankosi');
  assert.equal(new Set(queries).size, 3);
  assert.ok(queries.every(query => !query.includes('shenge_wasehlalankosi')));
  assert.ok(queries.some(query => query.includes('site:instagram.com')));
  assert.ok(queries.every(query => !query.includes('official')));
});

test('only direct profile URLs become candidate URLs', () => {
  assert.equal(directInstagramProfile('https://instagram.com/SHENGE_WASEHLALANKOSI/?hl=en'),
    'https://www.instagram.com/shenge_wasehlalankosi/');
  for (const url of [
    'https://instagram.com/p/abc/', 'https://instagram.com/reel/abc/',
    'https://instagram.com/accounts/', 'https://example.com/shenge/',
    'https://instagram.com.evil.test/shenge/', 'not a URL',
  ]) assert.equal(directInstagramProfile(url), null);
});
