import test from 'node:test';
import assert from 'node:assert/strict';
import {youtubeChannelUrl,youtubeSearchCandidates,youtubeEligibilitySql} from './youtube-discovery-test.mjs';

test('YouTube discovery accepts channel pages, not videos, playlists, or lookalike domains',()=>{
  assert.equal(youtubeChannelUrl('https://youtube.com/@artist?feature=shared'),'https://www.youtube.com/@artist');
  assert.equal(youtubeChannelUrl('https://music.youtube.com/channel/UCabcdefghijklmnopqrstuv'),'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv');
  for(const u of ['https://youtube.com/watch?v=abc','https://youtube.com/shorts/abc',
    'https://youtube.com/playlist?list=x','https://youtube.com/@artist/videos',
    'https://youtube.com.evil.test/@artist','http://youtube.com/@artist'])
    assert.equal(youtubeChannelUrl(u),null);
});
test('Search results preserve candidate evidence, deduplicate, and never claim ownership',()=>{
  const candidates=youtubeSearchCandidates({organic:[
    {link:'https://youtube.com/@artist',title:'Artist',snippet:'Official channel'},
    {link:'https://www.youtube.com/@artist?x=y'},
    {link:'https://youtube.com/watch?v=abc'}]});
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].snippet,'Official channel');
  assert.equal(candidates[0].verified,false);
  assert.deepEqual(youtubeSearchCandidates({organic:[]}),[]);
  assert.throws(()=>youtubeSearchCandidates({error:'provider failure'}),/Missing organic/);
});
test('Selection uses the single latest global snapshot, all five tiers, and absence of an existing YouTube URL',()=>{
  assert.match(youtubeEligibilitySql,/max\(computed_at\)/);
  assert.match(youtubeEligibilitySql,/grain='global'/);
  assert.match(youtubeEligibilitySql,/tier BETWEEN 1 AND 5/);
  assert.match(youtubeEligibilitySql,/disconnected_at IS NULL/);
  assert.match(youtubeEligibilitySql,/lower\(a.platform\)='youtube'/);
  assert.match(youtubeEligibilitySql,/LIMIT 4 BY t.tier/);
});
