import test from 'node:test';
import assert from 'node:assert/strict';
import {baseSongKey,groupBaseSongs,applyBaseSongCounting,baseSongSubmissionExclusion} from './youtube-base-song-policy.mjs';

test('the requested suffixes all count as one base composition',()=>{
  const versions=['Slowed','Sped Up','Ultra Slowed','Nightcore','Remix','Instrumental','Extended',
    'Radio Edit','Live','Acoustic','DJ Luna Remix','Acoustic Piano Version','Live at Wembley 2024',
    'Slowed + Reverb','2011 Remastered','Original Mix','Karaoke','0.8x','432Hz','Clean',
    'Sped-Up','Ultra-Slowed','Hardstyle','Psytrance'];
  assert.equal(groupBaseSongs(['Home',...versions.map(v=>'Home ('+v+')')]).length,1);
  for(const suffix of ['slowed','ultra slowed','sped up','nightcore','remix','instrumental','extended','radio edit','live','acoustic'])
    assert.equal(baseSongKey('Home '+suffix),baseSongKey('Home'));
});
test('stacked and nested version suffixes are removed repeatedly',()=>{
  assert.equal(baseSongKey('Home (Acoustic) [Ultra Slowed] - Radio Edit'),baseSongKey('Home'));
  assert.equal(baseSongKey('Home (Live (2024))'),baseSongKey('Home'));
  assert.equal(baseSongKey('Home - DJ Luna Remix - Instrumental'),baseSongKey('Home'));
  assert.equal(baseSongKey('Home - Ultra-Slowed'),baseSongKey('Home'));
  assert.equal(baseSongKey('Home-Ultra-Slowed'),baseSongKey('Home'));
});
test('standalone descriptor titles and meaningful non-version qualifiers survive',()=>{
  assert.ok(baseSongKey('Live'));assert.ok(baseSongKey('Instrumental'));
  assert.notEqual(baseSongKey('Home (Part II)'),baseSongKey('Home'));
  assert.notEqual(baseSongKey('Home (Live Forever)'),baseSongKey('Home'));
  assert.notEqual(baseSongKey('Home (Original Sin)'),baseSongKey('Home'));
  assert.notEqual(baseSongKey('Home (Piano Man)'),baseSongKey('Home'));
  assert.notEqual(baseSongKey('Home (feat. Alice)'),baseSongKey('Home'));
  assert.notEqual(baseSongKey('Slowed Memories'),baseSongKey('Memories'));
  assert.equal(groupBaseSongs(['Intro','Home','Other Song']).length,3);
});
const result=(level,matches,confidence='high')=>({evidenceLevel:level,confidence,status:'catalog_ready',
  matchedTracks:matches.map(([catalogTitle,release])=>({catalogTitle,matchedBy:release?['date_within_one_day']:[]})),
  confidenceReasons:[],reviewReason:''});
test('three variants cannot qualify as three titles or two releases',()=>{
  const r=applyBaseSongCounting(result('releases',[['Home',true],['Home (Acoustic)',true],['Home - Live',true]]));
  assert.equal(r.titleCount,1);assert.equal(r.releaseCount,1);
  assert.equal(r.confidence,'medium');assert.equal(r.status,'review');
});
test('a title-only three-version result becomes low; two real songs become medium',()=>{
  assert.equal(applyBaseSongCounting(result('titles',[['Home',false],['Home - Live',false],['Home - Remix',false]])).confidence,'low');
  assert.equal(applyBaseSongCounting(result('titles',[['Home',false],['Home - Live',false],['Away',false]])).confidence,'medium');
});
test('release counting does not borrow title-only matches or promote existing mediums',()=>{
  const r=applyBaseSongCounting(result('releases',[['Home',true],['Home - Acoustic',true],['Away',false]]));
  assert.equal(r.titleCount,2);assert.equal(r.releaseCount,1);assert.equal(r.confidence,'medium');
  assert.equal(applyBaseSongCounting(result('titles',[['One',false],['Two',false],['Three',false]],'medium')).confidence,'medium');
  const titles=applyBaseSongCounting(result('releases',[['Home',true],['Home - Acoustic',true],['Away',false],['Third',false]]));
  assert.equal(titles.evidenceLevel,'titles');assert.equal(titles.confidence,'high');
});
test('independent artist-declared evidence is not invalidated by song counting',()=>{
  assert.equal(applyBaseSongCounting(result('artist_declared',[])).confidence,'high');
});
test('submission gate fails closed for insufficient base songs and missing release proof',()=>{
  const row={confidence:'high',evidence_level:'titles',matched_titles:['Home','Home - Live','Home - Remix']};
  assert.equal(baseSongSubmissionExclusion(row),'insufficient_distinct_base_songs');
  assert.equal(baseSongSubmissionExclusion({...row,evidence_level:'releases',matched_titles:['Home','Away']}),
    'missing_base_song_release_count_proof');
  assert.equal(baseSongSubmissionExclusion({...row,evidence_level:'releases',matched_titles:['Home','Away'],
    confidence_reasons:'base_song_policy = distinct_base_songs_v1; distinct_base_release_songs = 2'}),null);
  assert.equal(baseSongSubmissionExclusion({...row,evidence_level:'releases_single_exact'}),null);
});
