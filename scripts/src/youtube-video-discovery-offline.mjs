// Pure planning helpers. Paid stages must freeze and separately approve their output.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {youtubeSearchNames} from './youtube-music-search.mjs';

export const digest = value => createHash('sha256').update(
  typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const hosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const channelId = /^UC[A-Za-z0-9_-]{22}$/;
const videoId = /^[A-Za-z0-9_-]{11}$/;
const tabs = new Set(['about', 'videos', 'shorts', 'streams', 'playlists', 'featured', 'community', 'releases']);
const norm = value => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function safeUrl(raw) {
  if (typeof raw !== 'string' || /[\s\\%]/u.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port
      || (!hosts.has(u.hostname) && u.hostname !== 'youtu.be')) return null;
    // Reject dot-segment canonicalization instead of silently accepting a different path.
    if (/\/\.{1,2}(?:\/|[?#]|$)/.test(raw)) return null;
    return u;
  } catch { return null; }
}
export function normalizeDiscoveryChannel(raw) {
  // Decode only a handle on an already allowlisted HTTPS authority. Never
  // decode hosts, separators, legacy IDs, query strings or double escapes.
  if (typeof raw === 'string' && raw.includes('%')) {
    const match = /^https:\/\/(?:www\.|m\.|music\.)?youtube\.com\/@([^/?#]+)/.exec(raw);
    if (!match) return null;
    try {
      const handle = decodeURIComponent(match[1]);
      if (!/^[\p{L}\p{N}_.-]{1,100}$/u.test(handle)
        || !/[^\x00-\x7f]/u.test(handle)) return null;
      raw = raw.slice(0, match[0].length - match[1].length)
        + handle + raw.slice(match[0].length);
    } catch { return null; }
  }
  const u = safeUrl(raw);
  if (!u || !hosts.has(u.hostname)) return null;
  const parts = u.pathname.replace(/\/$/, '').slice(1).split('/');
  // URL.pathname serializes literal non-ASCII characters as percent escapes.
  if (parts[0]?.startsWith('@')) {
    try { parts[0] = decodeURIComponent(parts[0]); } catch { return null; }
  }
  const count = parts[0]?.startsWith('@') ? 1 : 2;
  if (parts.length !== count && !(parts.length === count + 1 && tabs.has(parts[count]))) return null;
  if (count === 1 ? !/^@[\p{L}\p{N}_.-]{1,100}$/u.test(parts[0])
    : !(parts[0] === 'channel' ? channelId.test(parts[1] ?? '')
      : ['c', 'user'].includes(parts[0]) && /^[A-Za-z0-9_.-]{1,100}$/.test(parts[1] ?? ''))) return null;
  return 'https://www.youtube.com/' + parts.slice(0, count).join('/');
}
export function normalizeDiscoveryVideo(raw) {
  const u = safeUrl(raw);
  if (!u) return null;
  let id;
  if (u.hostname === 'youtu.be') id = /^\/([^/]+)\/?$/.exec(u.pathname)?.[1];
  else if (u.pathname === '/watch' && u.searchParams.getAll('v').length === 1) id = u.searchParams.get('v');
  else id = /^\/(?:shorts|live)\/([^/]+)\/?$/.exec(u.pathname)?.[1];
  return videoId.test(id ?? '') ? {videoId: id, url: 'https://www.youtube.com/watch?v=' + id} : null;
}
function binding(artist) {
  assert.match(String(artist.profileId ?? ''), /^\d+$/);
  assert.match(String(artist.cmArtist ?? ''), /^\d+$/);
  assert.ok(String(artist.name ?? artist.artist ?? '').trim(), 'Missing artist name');
  return {profileId: String(artist.profileId), cmArtist: String(artist.cmArtist)};
}
function role(text) {
  if (/\btopic\b|auto.generated|provided to youtube by/i.test(text)) return 'topic_or_distribution';
  if (/\b(?:records|label|vevo|network|entertainment|fan|covers?|nightcore|lyrics)\b/i.test(text))
    return 'organization_or_third_party_possible';
  return 'unknown';
}
// A matched phrase can be a recording title, not the catalog performer.
// These narrow holds affect future uploader-request planning only. They do not
// establish a different artist or remove archived evidence.
export function videoMentionHold(artist,row){
  const boundNames=youtubeSearchNames(artist);
  const names=boundNames.map(r=>norm(r.name));
  const title=norm(row.title),snippet=norm(row.snippet);
  for(const name of names){
    if((title+' '+snippet).includes(name+' is a ')&&( /\b(?:track|song)\b/.test(title+' '+snippet)))
      return 'artist_phrase_described_as_recording';
  }
  if(/\bsong by ai\b|\bai generated (?:song|music)\b/i.test(String(row.title)+' '+String(row.snippet)))
    return 'ai_song_identity_unbound';
  const parts=String(row.snippet??'').split(/[·•]/).map(norm);
  const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  // A distributor snippet can join the artist and recording name in one dot
  // segment. Accept an explicit bounded Main Artist credit, not any mention.
  const explicitMainArtist=boundNames.some(({name})=>new RegExp(
    '\\bmain artist:\\s*'+escape(String(name).normalize('NFKC').trim())+
    '(?=\\s*(?:[·•;|]|$)|\\s+(?:producer|composer|lyricist|writer|performer|released on):)',
    'iu').test(String(row.snippet??'').normalize('NFKC')));
  const distributionCredit=/provided to youtube by/i.test(row.snippet??'')
    &&(names.some(n=>parts.slice(1).includes(n))||explicitMainArtist);
  if(/provided to youtube by/i.test(row.snippet??'')&&parts.length>=2
    &&!distributionCredit)
    return 'distribution_credits_do_not_match_catalog_name';
  const rawTitle=String(row.title??'').normalize('NFKC').toLowerCase().replace(/^[^\p{L}\p{N}]+/u,'');
  // "Fantasy Music - <name>" describes a recording, not its performer.
  // Keep it as evidence, but do not spend an uploader slot on title overlap.
  if(boundNames.some(({name})=>new RegExp(
    '^(?:fantasy|epic|cinematic|relaxing|ambient|instrumental)\\s+music\\s*[-–—:]\\s*'+
    escape(String(name).normalize('NFKC').toLowerCase().trim())+'(?:\\s*[(\\[]|\\s*$)',
    'u').test(rawTitle)))return 'artist_phrase_is_instrumental_recording_title';
  const titleCredit=boundNames.some(({name})=>{
    const exact=escape(String(name).normalize('NFKC').toLowerCase().trim());
    return new RegExp('^'+exact+'\\s*(?:[-–—:|·(\\[]|$|\\b(?:official|music|video|lyrics|nightcore|topic)\\b)','u').test(rawTitle)
      ||new RegExp('[-–—|·]\\s*'+exact+'\\s*(?:[-–—|·(\\[]|$)','u').test(rawTitle);
  });
  const performerSide=String(row.title??'').split(/\s+[-–—]\s+/u);
  const collaborationCredit=performerSide.length>1&&performerSide[0].split(/,\s*/u)
    .some(performer=>names.includes(norm(performer)));
  if(!titleCredit&&!distributionCredit&&!collaborationCredit)
    return 'artist_mention_without_clear_performer_credit';
  return null;
}
export function planVideoDiscovery(artist, organic, provenance) {
  const bound = binding(artist);
  assert.ok(Array.isArray(organic), 'Missing organic results is not a no-match');
  assert.match(provenance.receiptSha256, /^[a-f0-9]{64}$/);
  assert.ok(provenance.archivePath);
  const names = youtubeSearchNames(artist).map(r => norm(r.name)).filter(Boolean);
  const channels = new Map(), videos = new Map(), snippetHandles = [];
  organic.forEach((row, index) => {
    const channel = normalizeDiscoveryChannel(row.link), video = normalizeDiscoveryVideo(row.link);
    if (!channel && !video) return;
    const title = String(row.title ?? ''), snippet = String(row.snippet ?? '');
    const text = norm(title + ' ' + snippet);
    const matchedNames = names.filter(name => (' ' + text + ' ').includes(' ' + name + ' '));
    const source = {...provenance, ...bound, resultIndex: index, sourceUrl: row.link, title, snippet,
      resultSha256: digest(row), matchedNames, roleHint: role(title + ' ' + snippet),
      videoMentionHold:videoMentionHold(artist,row),verified: false, ownershipEvidence: false};
    if (channel) {
      const clue = channels.get(channel) ?? {...bound, url: channel, sources: [],
        verified: false, ownershipEvidence: false};
      clue.sources.push(source); channels.set(channel, clue);
    }
    if (video) {
      const clue = videos.get(video.videoId) ?? {...bound, ...video, sources: [],
        verified: false, ownershipEvidence: false};
      clue.sources.push(source); videos.set(video.videoId, clue);
      // Text mentions are not uploader identities and never become channel URLs.
      for (const handle of snippet.match(/@[\p{L}\p{N}_.-]+/gu) ?? [])
        snippetHandles.push({...bound, handle, source, kind: 'unverified_snippet_mention',
          verified: false, ownershipEvidence: false});
    }
  });
  const allVideos = [...videos.values()].map(v => ({...v,
    eligible: v.sources.some(s => s.matchedNames.length > 0&&!s.videoMentionHold),
    priority: v.sources.some(s => s.roleHint === 'unknown') ? 0 : 1}));
  const eligible = allVideos.filter(v => v.eligible).sort((a, b) => a.priority - b.priority
    || a.sources[0].resultIndex - b.sources[0].resultIndex);
  // Preserve a distribution/Topic lead within the same two-request ceiling,
  // rather than letting two ordinary/promotional videos consume both slots.
  const selected=eligible.slice(0,1);
  const distribution=eligible.find(v=>v!==selected[0]
    &&v.sources.some(s=>!s.videoMentionHold&&s.roleHint==='topic_or_distribution'));
  const second=distribution??eligible.find(v=>v!==selected[0]);
  if(second)selected.push(second);
  return {...bound, channelClues: [...channels.values()], videoClues: allVideos,
    resolutionQueue: selected.map(v => ({...v,
      operation: {kind: 'video_uploader', key: `video_uploader-${bound.profileId}-${bound.cmArtist}-${v.videoId}`,
        reservationCents: 2, request: proposedUploaderRequest(v.url)}})),
    deferredVideos: eligible.filter(v=>!selected.includes(v)), snippetHandles,
    maximumVideoOperations: 2, verifiedMatches: 0, executable: false};
}

// Documented endpoint; still non-executable. See docs/youtube-video-uploader-review.md.
export function proposedUploaderRequest(url) {
  const video = normalizeDiscoveryVideo(url);
  assert.ok(video && video.url === url, 'Only canonical YouTube video URLs');
  return {method: 'GET', url: 'https://api.scrapecreators.com/v1/youtube/video?'
    + new URLSearchParams({url})};
}
// Canonical adapter receipt; NOT a claim that a current provider returns this schema.
// Raw receipt bytes and artist-bound operation identity are modeled separately in
// youtube-video-uploader-review.mjs; this legacy synthetic contract is not provider JSON.
export function resolveSavedUploader(artist, clue, receipt) {
  const bound = binding(artist), op = clue.operation;
  assert.equal(clue.profileId, bound.profileId); assert.equal(clue.cmArtist, bound.cmArtist);
  assert.equal(normalizeDiscoveryVideo(clue.url)?.videoId, clue.videoId);
  assert.equal(op.kind, 'video_uploader');
  assert.equal(op.key, `video_uploader-${bound.profileId}-${bound.cmArtist}-${clue.videoId}`);
  assert.deepEqual(op.request, proposedUploaderRequest(clue.url));
  assert.equal(receipt.profileId, bound.profileId); assert.equal(receipt.cmArtist, bound.cmArtist);
  assert.equal(receipt.operationKey, op.key);
  assert.equal(receipt.inputSha256, digest(op.request));
  assert.equal(receipt.bodySha256, digest(receipt.body));
  assert.equal(receipt.status, 200); assert.equal(receipt.body.videoId, clue.videoId);
  const uploader = receipt.body.uploader;
  assert.ok(channelId.test(uploader?.channelId ?? ''), 'Missing exact uploader channel ID');
  const url = 'https://www.youtube.com/channel/' + uploader.channelId;
  // Handle aliases require channel capture later; never infer ID equivalence from text.
  if (uploader.channelUrl) assert.equal(normalizeDiscoveryChannel(uploader.channelUrl), url,
    'Conflicting or unsafe uploader channel URL');
  const displayName = String(uploader.displayName ?? '');
  const sameName = youtubeSearchNames(artist).some(n => norm(n.name) === norm(displayName));
  return {...bound, url, uploaderName: displayName, sources: clue.sources,
    uploaderReceipt: {operationKey: op.key, inputSha256: receipt.inputSha256,
      bodySha256: receipt.bodySha256, receiptSha256: digest(receipt)},
    discoveryRoleHint: role(displayName),
    artistNameAgreement: sameName ? 'name_only_not_ownership' : 'different_or_unknown_uploader',
    requiresIndependentOwnershipCheck: true, verified: false, ownershipEvidence: false};
}
export function deduplicateArtistChannelClues(clues) {
  const map = new Map();
  for (const clue of clues) {
    const bound = binding({...clue, name: 'binding-only'}), url = normalizeDiscoveryChannel(clue.url);
    assert.ok(url);
    const key = JSON.stringify([bound.profileId, bound.cmArtist, url]);
    const record = map.get(key) ?? {...clue, url, observations: [], verified: false, ownershipEvidence: false};
    record.observations.push(clue); map.set(key, record);
  }
  return [...map.values()];
}

export function proposedVideoAllocation(artistCount = 20) {
  assert.ok(Number.isInteger(artistCount) && artistCount > 0 && artistCount <= 20);
  return {version: 'offline-video-discovery-v1', executable: false, explicitApproval: false,
    approvalStatus: 'requires_new_plan_and_spending_approval', inheritsApproval: false,
    artistCount, perArtist: {search: 1, video_uploader: 2, metadata: 1, model: 1},
    reservationPerCallCents: 2, maxCalls: artistCount * 5, capCents: artistCount * 10,
    noAutomaticRetries: true, noCatalogWrites: true};
}
// Pure design-time allocation check, not a transactional admission or authorization path.
export function assertProposedAllocationSlot(allocation, {profileId, kind, key}, history) {
  assert.deepEqual(allocation, proposedVideoAllocation(allocation.artistCount));
  assert.match(profileId, /^\d+$/); assert.ok(typeof key === 'string' && key.length > 0);
  assert.ok(Object.hasOwn(allocation.perArtist, kind), 'Unplanned provider operation');
  assert.ok(history.every(r => r.status === 'returned'), 'Uncertain admission blocks more work');
  assert.ok(!history.some(r => r.key === key), 'Never replay an admission');
  assert.ok(new Set([...history.map(r => r.profileId), profileId]).size <= allocation.artistCount);
  assert.ok(history.filter(r => r.profileId === profileId && r.kind === kind).length
    < allocation.perArtist[kind], 'Per-artist operation slots exhausted');
  assert.ok(history.length < allocation.maxCalls && (history.length + 1) * 2 <= allocation.capCents,
    'Call or spending fence');
  return {admitted: false, executable: false, reason: 'offline_design_only_new_approval_required'};
}
