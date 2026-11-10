import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {auditReferenceLinks, extractReferenceAnchors, referenceTargets, sha256} from './instagram-reference-links.mjs';
import {checkReferenceLinks} from './instagram-reference-label-audit.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('../fixtures/instagram-reference-links.json', import.meta.url)));
const row = fixture.cases[0], target = referenceTargets[row.profileId];
const snapshot = (html = row.html, extra = {}) => ({html, bodySha256: sha256(html),
  url: row.archive.url, at: row.archive.at, status: 200, ...extra});

test('three observed pairs survive icon-only extraction with exact, canonical IDs and provenance', async () => {
  const report = await checkReferenceLinks();
  assert.equal(report.archivesVerified, false);
  assert.equal(report.results.length, 3);
  for (const result of report.results) {
    assert.equal(result.state, 'expected_links_found');
    assert.deepEqual(result.matched, {instagram: true, spotify: true});
    assert.equal(result.absenceEstablished, false);
    assert.equal(result.readableTextState, 'empty_or_unavailable');
    assert.equal(result.links.length, 2);
    assert.match(result.source.bodySha256, /^[a-f0-9]{64}$/);
    assert.match(result.archive.bodySha256, /^[a-f0-9]{64}$/);
    assert.equal(result.source.at, result.archive.at);
    assert.notEqual(result.source.bodySha256, result.archive.bodySha256);
    assert.ok(result.readableArchive.at < result.archive.at);
  }
  assert.deepEqual(await checkReferenceLinks(), report, 'Offline output must be deterministic.');
});

test('CLI is offline even with the legacy paid flag present, and works outside the workspace', () => {
  const output = execFileSync(process.execPath,
    [new URL('./instagram-reference-label-audit.mjs', import.meta.url).pathname,
      '--check-reference-links', '--run-approved-audit'],
    {cwd: '/tmp', env: {PATH: process.env.PATH}, encoding: 'utf8', timeout: 5000});
  const report = JSON.parse(output);
  assert.equal(report.networkRequests, 0);
  assert.equal(report.paidCalls, 0);
  assert.equal(report.imports, 0);
});

test('tracking, fragment and host aliases collapse while retaining each observed href', () => {
  const links = extractReferenceAnchors(row.html);
  assert.equal(links.length, 2);
  assert.equal(links[0].observedHrefs.length, 2);
  assert.equal(links[0].id, target.instagram);
  assert.ok(links[0].observedHrefs.some(href => href.includes('&hl=en')));
  const intl = `<A HREF="https://open.spotify.com/intl-fr/artist/${target.spotify}?si=x&amp;utm_source=y"><svg/></A>`;
  assert.equal(extractReferenceAnchors(intl)[0].url, `https://open.spotify.com/artist/${target.spotify}`);
});

test('exact IDs, not prefixes, titles, albums, readable text or one-platform matches', () => {
  for (const html of ['', '<p>Aimee Carty official Instagram Spotify</p>',
    row.html.replaceAll(target.instagram, `${target.instagram}x`).replaceAll('AIMEE.CARTY_MUSIC', 'other'),
    row.html.replaceAll(target.spotify, `${target.spotify}X`),
    row.html.replaceAll('/artist/', '/album/')]) {
    const result = auditReferenceLinks(snapshot(html, {readableText: row.observedHrefs.join('\n')}), target);
    assert.equal(result.state, 'needs_source_review');
    assert.equal(result.absenceEstablished, false);
  }
});

test('empty/unavailable readable text never proves absence, including incomplete source responses', () => {
  for (const readableText of [undefined, '', '   ']) {
    assert.equal(auditReferenceLinks(snapshot('', {readableText}), target).state, 'needs_source_review');
    for (const extra of [{status: 403}, {status: 404}, {status: 302}, {truncated: true}]) {
      const result = auditReferenceLinks(snapshot('', {...extra, readableText}), target);
      assert.equal(result.state, 'source_incomplete');
      assert.equal(result.absenceEstablished, false);
    }
  }
});

test('only separately approved first-party source URLs qualify, even when both exact links appear', () => {
  for (const url of [fixture.negative.archive.url, 'https://aimeecarty.com.attacker.test/',
    'https://aimeecarty.com/promoted', 'https://aimeecarty.com/?redirect=1',
    'https://attacker.test/?url=https://aimeecarty.com/', 'http://aimeecarty.com/',
    'https://user:pass@aimeecarty.com/', 'https://aimeecarty.com:8443/']) {
    const result = auditReferenceLinks(snapshot(fixture.negative.html, {url}), target);
    assert.equal(result.state, 'source_not_approved');
    assert.deepEqual(result.links, []);
  }
  assert.equal(auditReferenceLinks(snapshot(row.html, {url: 'https://aimeecarty.com/'}), target).state,
    'expected_links_found');
});

test('ignore scripts, comments, templates, text and non-account or unsafe hrefs', () => {
  const fake = `<a href="${row.observedHrefs[0]}"><svg/></a>`;
  for (const html of [`<!-- ${fake} -->`, `<script>${fake}</script>`,
    `<style>${fake}</style>`, `<textarea>${fake}</textarea>`, `<template><template>${fake}</template></template>`,
    `<p>${row.observedHrefs[0]}</p>`, `<a data-href="${row.observedHrefs[0]}">Instagram</a>`,
    `<a href="https://attacker.test/?url=${row.observedHrefs[0]}">redirect</a>`]) {
    assert.deepEqual(extractReferenceAnchors(html), []);
  }
  const unsafe = ['http://instagram.com/example', 'https://instagram.com.evil.test/example',
    'https://user:pass@instagram.com/example', 'https://instagram.com:8443/example',
    'https://instagram.com/p/ABC', 'https://instagram.com/accounts/',
    'https://instagram.com/example/extra', 'https://open.spotify.com/track/'+target.spotify];
  assert.deepEqual(extractReferenceAnchors(unsafe.map(href => `<a href="${href}"/>`).join('')), []);
  assert.equal(extractReferenceAnchors(`<a title="x > y" HREF='https://instagram.com/ernest/'><svg/></a>`)[0].id, 'ernest');
  assert.deepEqual(extractReferenceAnchors(`<a href="bad" href="${row.observedHrefs[0]}">bad</a>`), []);
  assert.equal(extractReferenceAnchors('<a href="https:&#47;&#47;instagram.com/ernest/"><svg/></a>')[0].id, 'ernest');
});

test('tampered hashes, missing observation times and oversized input fail explicitly', () => {
  assert.throws(() => auditReferenceLinks(snapshot('', {bodySha256: row.archive.bodySha256}), target), /hash mismatch/);
  for (const at of [undefined, '', 'not-a-date']) assert.throws(() => auditReferenceLinks(snapshot('', {at}), target), /timestamp/);
  assert.throws(() => extractReferenceAnchors('x'.repeat(1_000_001)), /byte limit/);
  assert.throws(() => extractReferenceAnchors('<a href=x>'.repeat(1001)), /Anchor limit/);
  assert.throws(() => extractReferenceAnchors('<b>'.repeat(20_001)), /tag limit/);
  assert.throws(() => extractReferenceAnchors(`<a href="${'x'.repeat(4097)}">`), /Href byte limit/);
  assert.throws(() => auditReferenceLinks(snapshot(), null), /target required/);
});
