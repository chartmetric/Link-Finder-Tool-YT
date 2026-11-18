// Offline reporting only. No providers, database clients, policy modules or workers.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => sha(JSON.stringify(value));
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const pairKey = row => [row.profile_id, row.cm_artist, row.youtube_url].join('|');

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === '\n')) {
      row.push(cell.replace(/\r$/, '')); cell = '';
      if (ch === '\n') { rows.push(row); row = []; }
    } else cell += ch;
  }
  assert.ok(!quoted, 'Unterminated CSV field');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift();
  return rows.filter(r => r.some(Boolean)).map(r => {
    assert.equal(r.length, headers.length, 'CSV column count');
    return Object.fromEntries(headers.map((h, i) => [h, r[i]]));
  });
}

export function accuracyMetrics(rows) {
  const counts = {total: rows.length, correct: 0, wrong: 0, unsure: 0, unreviewed: 0};
  for (const r of rows) {
    assert.ok(['correct', 'wrong', 'unsure', 'unreviewed'].includes(r.review_label));
    counts[r.review_label]++;
  }
  const scorable = counts.correct + counts.wrong;
  return {...counts, reviewed: counts.total - counts.unreviewed, scorable,
    unscorable: counts.unsure, // Examined, but insufficient evidence for a binary grade.
    reviewedScorablePrecision: scorable ? counts.correct / scorable : null,
    confirmedShareOfAllSuggestions: counts.total ? counts.correct / counts.total : null,
    allSuggestionPrecisionBounds: counts.total
      ? [counts.correct / counts.total, (counts.total - counts.wrong) / counts.total] : null,
    meets65AmongScorable: scorable ? counts.correct / scorable >= .65 : null,
    fullSetTargetEstablished: counts.total > 0 && counts.correct / counts.total >= .65};
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
  ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));

export function renderReport(metrics, rows, evidence) {
  const counts = m => `<tr><td>${m.total === 58 ? 'All suggestions' : m.total === 52
    ? 'Topic — auto-generated' : 'Artist-facing — management unverified'}</td>
    <td>${m.total}</td><td>${m.correct}</td><td>${m.wrong}</td><td>${m.unsure}</td>
    <td>${m.unreviewed}</td><td>${m.scorable}</td><td>${m.reviewedScorablePrecision === null
      ? 'Not measurable' : (100 * m.reviewedScorablePrecision).toFixed(1) + '%'}</td></tr>`;
  const pairs = rows.map((r, i) => {
    const e = evidence[i];
    return `<article><h3>${r.row_number}. ${escapeHtml(r.artist)} — <span class="${r.review_label}">${r.review_label.toUpperCase()}</span></h3>
      <p><a href="${escapeHtml(r.youtube_url)}">${escapeHtml(r.reviewed_channel_name)}</a><br>
      ${escapeHtml(r.channel_type_label)} · ${escapeHtml(r.scorability)}<br>
      Catalog profile ${escapeHtml(r.profile_id)} / cm_artist ${escapeHtml(r.cm_artist)}<br>
      <code>${escapeHtml(r.canonical_channel_id)}</code></p>
      <p>${escapeHtml(r.review_reason)}</p>
      <details><summary>Saved evidence and provenance</summary>
      <p>Observed ${escapeHtml(r.evidence_observed_at)}. Original receipt: <code>${escapeHtml(r.channel_receipt)}</code>.
      Original provider bytes SHA-256: <code>${escapeHtml(r.raw_body_sha256)}</code>.</p>
      <h4>Captured channel</h4><pre>${escapeHtml(JSON.stringify(e.capture, null, 2))}</pre>
      <h4>Catalog accounts and releases</h4><pre>${escapeHtml(JSON.stringify({
        accounts: e.artist.accounts.map(a => ({platform: a.platform, url: a.account_url})),
        country: e.artist.country, releases: e.artist.releases}, null, 2))}</pre>
      <h4>Captured videos on this exact channel</h4><pre>${escapeHtml(JSON.stringify(e.sameChannelVideos.map(v =>
        ({videoId: v.videoId, title: v.title, description: v.description,
          receipt: v.originalReceipt.receipt, rawBodySha256: v.originalReceipt.rawBodySha256})), null, 2))}</pre>
      <h4>Other-channel videos, not identity proof for this channel</h4><pre>${escapeHtml(JSON.stringify(e.otherVideos, null, 2))}</pre>
      <h4>Search context only, not captured metadata</h4><p>${escapeHtml(e.searchSnippet)}</p>
      </details></article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Review of 58 YouTube suggestions</title>
    <style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px}
    h1,h2,h3{line-height:1.25}article{border-top:1px solid #8888;padding:18px 0}
    table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #8888}
    .table{overflow:auto}.callout{padding:16px;border:2px solid #8888;border-radius:8px}
    pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;padding:12px;background:#8881}
    code{overflow-wrap:anywhere}a{color:light-dark(#006052,#75dec2)}summary{cursor:pointer}
    .wrong{color:light-dark(#a01818,#ffadad)}.correct{color:light-dark(#076345,#8ce8b8)}
    .unsure{color:light-dark(#805600,#f0d385)}small{display:block}</style></head>
    <body><h1>Accuracy review: 58 YouTube suggestions</h1><p>Saved-evidence review · 18 November 2026 · 56 artists</p>
    <section class="callout"><strong>The 65% full-set precision target is not established.</strong>
    <p>3 correct, 2 wrong, 53 unsure/unscorable; none unreviewed. Confirmed share of all suggestions:
    <strong>3/58 = 5.2%</strong>. This is a confirmed lower bound, not an estimate that only 5.2% are actually correct.
    At least 38/58 must be confirmed to reach 65%; 35 additional confirmations are needed.</p>
    <p>Among the five pairs with sufficient evidence for a binary grade, precision is <strong>3/5 = 60%</strong>.
    This selected subset is too small and evidence-biased to establish the other 53 pairs' accuracy.
    Full-set possible precision remains 5.2%–96.6%.</p></section>
    <h2>Separate channel-type results</h2><div class="table"><table><thead><tr><th>Type</th><th>Total</th>
    <th>Correct</th><th>Wrong</th><th>Unsure</th><th>Unreviewed</th><th>Scorable</th><th>Scorable precision</th>
    </tr></thead><tbody>${[metrics.all, metrics.topic, metrics.artistFacing].map(counts).join('')}</tbody></table></div>
    <p>Correct Topic associations describe auto-generated music presence, never artist management.
    The 100% result for two scorable artist-facing pairs is not 100% accuracy for all six.</p>
    <h2>What was reviewed</h2><p>A single Replit Agent independently adjudicated saved source evidence,
    rather than copying the archived model's verdict. This is <strong>not human review</strong>,
    not a blinded or held-out benchmark, not a new model vote, and not live validation.
    The reviewer had access to historical verdicts; no reviewer-agreement or population claim is made.
    Labels concern the captured evidence from 17–18 November 2026, not present-day account ownership.</p>
    <p>Correct: captured corroboration connects this channel to the exact catalog artist beyond a matching
    name or an outgoing Spotify link alone. Wrong: affirmative evidence identifies another entity.
    Unsure/unscorable: examined but insufficient for a binary grade; not rejected.
    Search snippets remain discovery context, not full video or account captures.
    Even a correct representation result leaves channel management unverified.</p>
    <h2>Confirmed mistakes</h2><ul><li>Trendy Boy → DJ Save - Topic:
    the saved video credits Trendy Boy as a collaborator, not the channel identity.</li>
    <li>Section Five → Balcony Mix Africa - Topic: a collaboration on Istina does not identify
    Balcony Mix Africa's channel as Section Five's.</li></ul>
    <p>Three further channel captures are titled <em>Wicked With You</em> (Tom Carroll),
    <em>Ambiance</em> (Br@m), and <em>Unsure</em> (Georgia Cait). Their collection-help links and search
    snippets do not establish exact artist-channel URLs. They remain unsure, not newly rejected artists.</p>
    <h2>Coverage and historical decisions stayed separate</h2><p>The frozen batch still has
    <strong>56/100 artists with suggestions</strong>, not 56 confirmed artists.
    Recovery newly covered 32 artists and placed one previous artist on hold:
    25 + 32 − 1 = 56, a net gain of 31. The shared-channel hold on
    <code>UCtXS5ljfO4NG94I6ResVFKg</code> remains in place for Villager SA and Mokgaetse;
    neither pair enters the 58-link scoring denominator. Kuto's two distinct IDs and THE DEADER END's
    two distinct IDs are separate reviewed links, not four distinct artists.</p>
    <p>No archive, historical model answer, campaign counter, production rule or catalog link was changed.
    No searches, paid calls, provider refreshes or catalog writes occurred.
    These findings authorize no imports, artist-specific overrides or policy activation.</p>
    <h2>All exact pairs</h2>${pairs}
    <h2>Reproduce</h2><pre>node --test scripts/src/youtube-suggestion-accuracy.test.mjs
node scripts/src/youtube-suggestion-accuracy.mjs</pre>
    <p>Every original channel receipt and same-channel video cited here was bound to profile_id,
    cm_artist, request and capture time, with the original raw-file SHA-256 checked in its owning archive.
    The four source exports were byte-hash checked before and after report generation.
    A normalized packet hash is not substituted for original provider bytes.</p>
    </body></html>`;
}

async function receiptIndex() {
  const records = [];
  for (const dir of (await fs.readdir('generated-artifacts')).filter(n => n.startsWith('youtube-test-100'))) {
    const root = 'generated-artifacts/' + dir;
    let names;
    try { names = await fs.readdir(root + '/receipts'); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const name of names.filter(n => n.endsWith('.json'))) {
      const file = root + '/receipts/' + name, meta = await json(file);
      if (meta.kind !== 'metadata' || meta.status !== 200 || !meta.rawPath) continue;
      records.push({root, file, meta});
    }
  }
  return records;
}

async function boundReceipt(index, artist, capture, resource, id) {
  const matches = index.filter(({meta}) => meta.profileId === artist.profileId
    && meta.cmArtist === artist.cmArtist && meta.at === capture.capturedAt
    && new URL(meta.request.url).pathname === '/v1/youtube/' + resource);
  for (const item of matches) {
    const {root, file, meta} = item;
    assert.ok(meta.rawPath.startsWith('receipts/') && !meta.rawPath.split('/').includes('..'));
    const rawFile = root + '/' + meta.rawPath, raw = await fs.readFile(rawFile);
    assert.equal(sha(raw), meta.rawBodySha256, 'Original raw receipt bytes changed');
    assert.equal(digest(meta.request), meta.inputSha256, 'Request binding changed');
    const data = JSON.parse(raw);
    if (resource === 'channel' && data.channelId !== id) continue;
    const target = new URL(meta.request.url).searchParams;
    if (resource === 'channel') assert.equal(target.get('url'), capture.requestedUrl);
    else assert.equal(target.get('videoId') ?? target.get('url')?.split('v=')[1], id);
    // Channel identity and capture time bind projections to their original archive.
    if (resource === 'channel') {
      assert.equal(data.name, capture.body.displayName);
      assert.equal(data.description ?? '', capture.body.description);
      assert.deepEqual(data.links ?? [], capture.body.externalUrls);
      assert.equal(digest(capture.body), capture.bodySha256);
    }
    return {receipt: file, receiptFileSha256: sha(await fs.readFile(file)),
      rawFile, rawBodySha256: meta.rawBodySha256, requestedResource: meta.request.url,
      observedAt: meta.at, data};
  }
  throw new Error(`Missing original ${resource} receipt: ${artist.profileId} ${id}`);
}

export async function buildAccuracyReview({
  decisionsFile = 'docs/reviews/youtube-58-adjudications.json',
  output = 'generated-artifacts/youtube-58-accuracy-review-20261118',
} = {}) {
  const decisions = await json(decisionsFile), source = decisions.source;
  assert.ok(path.resolve(output) !== path.resolve(source)
    && !path.resolve(output).startsWith(path.resolve(source) + path.sep), 'Separate report directory required');
  // Freeze input bytes before consulting source records. Never update these archives.
  for (const [name, hash] of Object.entries(decisions.sourceHashes))
    assert.equal(sha(await fs.readFile(source + '/' + name)), hash, 'Frozen source changed: ' + name);
  const suggestions = parseCsv(await fs.readFile(source + '/youtube-suggestions.csv', 'utf8'));
  const records = await json(source + '/results.json'), summary = await json(source + '/summary.json');
  assert.equal(suggestions.length, 58);
  assert.equal(new Set(suggestions.map(pairKey)).size, 58);
  assert.equal(new Set(suggestions.map(r => r.profile_id + '|' + r.cm_artist)).size, 56);
  assert.equal(decisions.reviews.length, 58);
  assert.equal(new Set(decisions.reviews.map(r => r[0])).size, 58);
  const index = await receiptIndex(), evidence = [], rows = [];
  for (let n = 1; n <= suggestions.length; n++) {
    const original = suggestions[n - 1], decision = decisions.reviews.find(r => r[0] === n);
    assert.ok(decision, 'Every source row requires explicit review');
    const artistRecord = records.find(a => a.artist.profileId === original.profile_id
      && a.artist.cmArtist === original.cm_artist);
    assert.ok(artistRecord);
    const id = original.youtube_url.split('/').at(-1);
    const candidates = artistRecord.candidates.filter(c => c.status === 'review_suggestion'
      && c.capture?.body.channelId === id);
    assert.equal(candidates.length, 1);
    const candidate = candidates[0], cap = candidate.capture;
    const receipt = await boundReceipt(index, artistRecord.artist, cap, 'channel', id);
    // Keep captured aliases distinct from canonical IDs; never infer an alias by name.
    assert.ok(candidate.url === original.youtube_url || cap.body.channelId === id);
    const sameChannelVideos = [];
    for (const video of artistRecord.videoContexts ?? []) {
      if (video.channelId !== id) continue;
      const bound = await boundReceipt(index, artistRecord.artist,
        {capturedAt: video.capturedAt}, 'video', video.videoId);
      assert.equal(bound.data.channel?.id ?? bound.data.channelId, id);
      assert.equal(bound.data.title, video.title);
      assert.equal(bound.data.description, video.description);
      sameChannelVideos.push({...video, originalReceipt: bound});
    }
    const row = {...original, row_number: n, canonical_channel_id: id,
      reviewed_channel_name: cap.body.displayName,
      review_status: 'reviewed', review_label: decision[1],
      scorability: ['correct', 'wrong'].includes(decision[1]) ? 'scorable' : 'unscorable',
      review_reason: decision[2], reviewer: decisions.reviewer, review_date: decisions.reviewDate,
      evidence_observed_at: cap.capturedAt, channel_receipt: receipt.receipt,
      raw_body_sha256: receipt.rawBodySha256, alias_requested: cap.requestedUrl,
      same_channel_video_ids: sameChannelVideos.map(v => v.videoId).join(';'),
      management_verified_by_review: false, review_authorizes_import: false};
    rows.push(row);
    evidence.push({pair: pairKey(row), artist: artistRecord.artist,
      capture: cap.body, channelReceipt: receipt, sameChannelVideos,
      otherVideos: (artistRecord.videoContexts ?? []).filter(v => v.channelId !== id)
        .map(v => ({videoId: v.videoId, channelId: v.channelId, title: v.title})),
      searchTitle: candidate.title, searchSnippet: candidate.snippet,
      searchEvidenceWarning: 'Discovery context only, not a full channel or video capture'});
  }
  const holdId = 'UCtXS5ljfO4NG94I6ResVFKg';
  const holds = records.flatMap(a => a.candidates.filter(c =>
    c.capture?.body.channelId === holdId && c.status === 'held').map(c =>
    ({artist: a.artist.name, profileId: a.artist.profileId, cmArtist: a.artist.cmArtist,
      channelId: holdId, status: c.status, reason: c.reason})));
  assert.deepEqual(holds.map(h => h.artist).sort(), ['Mokgaetse', 'Villager SA']);
  assert.ok(!rows.some(r => r.canonical_channel_id === holdId));
  assert.equal(rows.filter(r => r.channel_type_label === 'Topic — auto-generated').length, 52);
  assert.equal(summary.suggestedArtists, 56);
  const metrics = {reviewer: decisions.reviewer, date: decisions.reviewDate,
    all: accuracyMetrics(rows),
    topic: accuracyMetrics(rows.filter(r => r.channel_type_label === 'Topic — auto-generated')),
    artistFacing: accuracyMetrics(rows.filter(r => r.channel_type_label.startsWith('Artist-facing'))),
    historicalSuggestionCoverage: {artists: 56, cohort: 100, baselineArtists: 25,
      newlyCoveredArtists: 32, previousArtistNowHeld: 1, netGain: 31},
    preservedSharedChannelHolds: holds, sourceHashes: decisions.sourceHashes,
    newNetworkCalls: 0, catalogWrites: 0, historicalDecisionsChanged: 0,
    limitations: 'Offline single-agent evidence adjudication, not independent human review, blind testing, current live validation or population calibration.'};
  await fs.mkdir(output, {recursive: true});
  const columns = Object.keys(rows[0]), quote = x => '"' + String(x ?? '').replaceAll('"', '""') + '"';
  await fs.writeFile(output + '/reviewed-pairs.csv', '\uFEFF' + [columns, ...rows.map(r => columns.map(k => r[k]))]
    .map(r => r.map(quote).join(',')).join('\r\n') + '\r\n');
  await fs.writeFile(output + '/metrics.json', JSON.stringify(metrics, null, 2) + '\n');
  await fs.writeFile(output + '/evidence.json', JSON.stringify(evidence, null, 2) + '\n');
  await fs.writeFile(output + '/review.html', renderReport(metrics, rows, evidence));
  // Source archive must still be byte-identical after report generation.
  for (const [name, hash] of Object.entries(decisions.sourceHashes))
    assert.equal(sha(await fs.readFile(source + '/' + name)), hash);
  return {output, metrics, rows};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await buildAccuracyReview();
  console.log(JSON.stringify({output: result.output, metrics: result.metrics}, null, 2));
}
