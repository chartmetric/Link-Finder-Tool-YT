import { test } from 'node:test';
import assert from 'node:assert/strict';
import { musicianInstagramNoCandidatesToCsv } from './musician-instagram-research-csv.ts';
import type { MusicianInstagramResearchNoCandidates } from '@workspace/api-client-react';

const report: MusicianInstagramResearchNoCandidates = {
  generatedAt: '2026-11-03T20:15:00.000Z',
  profiles: [
    {
      artist: 'Artist, "One"',
      profileId: '9007199254740993',
      cmArtist: '12345',
      chartmetricUrl: 'https://app.chartmetric.com/artist/12345',
      outcome: 'completed_no_candidate',
      lastSearchAt: '2026-11-03 20:00:00',
    },
    {
      artist: '=HYPERLINK("https://bad.example")',
      profileId: '456',
      cmArtist: '789',
      chartmetricUrl: 'https://app.chartmetric.com/artist/789',
      outcome: 'failed',
      lastSearchAt: '2026-11-03 20:01:00',
    },
    {
      artist: 'Not searched',
      profileId: '12',
      cmArtist: '34',
      chartmetricUrl: 'https://app.chartmetric.com/artist/34',
      outcome: 'not_searched',
      lastSearchAt: null,
    },
    {
      artist: 'Still searching',
      profileId: '13',
      cmArtist: '35',
      chartmetricUrl: 'https://app.chartmetric.com/artist/35',
      outcome: 'incomplete',
      lastSearchAt: '2026-11-03 20:02:00',
    },
  ],
};

test('artist export includes requested columns and preserves distinct saved outcomes', () => {
  const csv = musicianInstagramNoCandidatesToCsv(report);
  assert.match(csv, /^"artist_name","profile_id","cm_artist","chartmetric_url","outcome","last_search_time"/);
  assert.match(csv, /"Artist, ""One""","9007199254740993","12345"/);
  assert.match(csv, /"completed_no_candidate","2026-11-03 20:00:00"/);
  assert.match(csv, /"failed","2026-11-03 20:01:00"/);
  assert.match(csv, /"incomplete"/);
  assert.match(csv, /"'=HYPERLINK/);
  assert.match(csv, /"not_searched",""\r?$/m);
});
