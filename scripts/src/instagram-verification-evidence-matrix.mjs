// Offline contract fixtures only. Expected labels are never sent to a provider.
import { readFileSync } from 'node:fs';
import { resolveMusicEvidence, parsePublicMusicPage } from './public-music-links.mjs';
import { jevRequest } from './instagram-pilot-live-transport.mjs';
import { assessInstagramCandidates } from './musician-instagram-matching.mjs';

export const evidenceMatrix = JSON.parse(readFileSync(
  new URL('./fixtures/instagram-verification-evidence-matrix.json', import.meta.url)));

const artistUrl = 'https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
const otherArtist = 'https://open.spotify.com/artist/BBBBBBBBBBBBBBBBBBBBBB';
const album = 'https://open.spotify.com/album/CCCCCCCCCCCCCCCCCCCCCC';
const track = 'https://open.spotify.com/track/DDDDDDDDDDDDDDDDDDDDDD';
const instagram = 'https://www.instagram.com/fixture.musician/';
const hub = 'https://onerpm.link/fixture-release';
const embed = url => url.replace('open.spotify.com/', 'open.spotify.com/embed/');
const entityHtml = entity => `<script id="__NEXT_DATA__">${JSON.stringify({
  props: { pageProps: { state: { data: { entity } } } },
})}</script>`;

export async function runEvidenceFixture(fixture) {
  const reference = { platform: 'spotify', url: artistUrl, displayName: 'Fixture Musician', externalUrls: [] };
  const candidate = { platform: 'instagram', url: instagram, displayName: 'Fixture Musician',
    bio: 'Musician', directExternalUrls: [], externalUrls: [] };
  const reads = [];
  if (fixture.evidence === 'direct') candidate.directExternalUrls = candidate.externalUrls = [artistUrl];
  else if (fixture.evidence === 'reciprocal') reference.externalUrls = [instagram];
  else if (fixture.evidence !== 'missing') {
    candidate.directExternalUrls = [hub];
    const credits = fixture.evidence === 'wrong_artist' ? [otherArtist]
      : fixture.evidence === 'multi_artist' ? [artistUrl, otherArtist] : [artistUrl];
    const pages = new Map([
      [hub, `<a data-service="spotify" href="${album}">Spotify</a>`],
      [embed(album), entityHtml({ type: 'album', uri: `spotify:album:${album.split('/').at(-1)}`,
        trackList: [{ uri: `spotify:track:${track.split('/').at(-1)}` }] })],
      [embed(track), entityHtml({ type: 'track', uri: `spotify:track:${track.split('/').at(-1)}`,
        artists: credits.map(url => ({ uri: `spotify:artist:${url.split('/').at(-1)}` })) })],
    ]);
    candidate.externalLinkEvidence = await resolveMusicEvidence({ candidate, catalog: reference,
      readPage: async url => {
        reads.push(url);
        if (fixture.evidence === 'unavailable') throw new Error('Fixture page unavailable');
        if (!pages.has(url)) throw new Error(`Unexpected fixture page: ${url}`);
        return parsePublicMusicPage(url, pages.get(url));
      } });
    candidate.externalUrls = [...candidate.directExternalUrls, ...candidate.externalLinkEvidence.externalUrls];
  }
  if (fixture.evidence === 'fan') candidate.bio = 'Fan page for Fixture Musician';
  if (fixture.evidence === 'label') candidate.bio = 'Record label representing Fixture Musician';
  if (fixture.evidence === 'unbound') candidate.url = 'https://www.instagram.com/another.fixture/';
  const linked = candidate.externalUrls.includes(artistUrl) || reference.externalUrls.includes(instagram);
  const profile = { url: instagram, title: 'Fixture Musician',
    identityComparison: { reference, candidate, status: linked ? 'likely' : 'uncertain',
      reasons: [linked ? 'Exact catalog account cross-link' : 'No exact cross-link'] },
    // Deliberately injected response, not a measured model decision.
    jevVerification: { verdict: fixture.verdict, sameIdentityProbability: fixture.score } };
  const payload = { artist: 'Fixture Musician', catalogReference: { platform: 'spotify', url: artistUrl },
    profiles: [profile] };
  const before = JSON.stringify(payload);
  const serialized = JSON.stringify(jevRequest(payload));
  const assessment = assessInstagramCandidates({ profiles: [profile],
    methodsUsed: [{ method: 'serper', status: 'used' }] }, {
    artist: payload.artist, profile_id: 'fixture', account_ids: ['fixture-account'],
    accounts: [{ account_id: 'fixture-account', platform: 'spotify', account_url: artistUrl }],
  });
  return { fixture, reads, payload, serialized, unchanged: before === JSON.stringify(payload),
    assessment, request: JSON.parse(serialized), observed: assessment.candidates[0].status };
}
