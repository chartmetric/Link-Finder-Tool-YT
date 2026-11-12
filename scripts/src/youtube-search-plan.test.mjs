import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {youtubeSearchPlan,rankYoutubeSearchCandidates} from './youtube-search-plan.mjs';
import {youtubeSearchCandidates} from './youtube-discovery-test.mjs';
const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/youtube-search-pilot.json',import.meta.url),'utf8'));
const artist=(name='Pencing')=>({profileId:'1',cmArtist:'2',name,
  catalogProfile:{profile_id:'1',cm_artist:'2',name},accounts:[],releases:[]});
const rank=(data,a=artist(),limit=2)=>rankYoutubeSearchCandidates(youtubeSearchCandidates(data),youtubeSearchPlan(a),{limit});

test('recorded relevance failures are not request substitutions or proven absence',()=>{
  for(const row of fixture.searches.slice(0,3)){
    assert.equal(row.query,row.echo);
    const a={...artist(row.artist),profileId:row.profileId,cmArtist:row.cmArtist,
      catalogProfile:{profile_id:row.profileId,cm_artist:row.cmArtist,name:row.artist}};
    const result=rank(row,a);
    assert.equal(result.candidates.length,0);
    assert.equal(result.channelAbsenceProven,false);
    assert.equal(result.outcome,row.artist==='Cytrena'?'no_channel_result_in_recorded_search':'off_target_results_only');
    assert.ok(result.allSearchCandidates.every(c=>!c.verified&&!c.relevance.ownershipProven));
    assert.match(youtubeSearchPlan(a).request.q,new RegExp('"'+row.artist+'"'));
    assert.match(youtubeSearchPlan(a).request.q,/music OR musician OR songs OR band/);
    assert.ok(!youtubeSearchPlan(a).request.q.includes('artist official'));
  }
});
test('queries quote exact names including non-Latin scripts and neutralize query operators in names',()=>{
  assert.match(youtubeSearchPlan(artist('島民')).request.q,/^"島民"/u);
  assert.match(youtubeSearchPlan(artist('AC/DC')).request.q,/^"AC\/DC"/u);
  assert.match(youtubeSearchPlan(artist('X" OR site:evil.test "')).request.q,/^"X OR site:evil.test "/u);
  assert.equal(youtubeSearchPlan(artist()).request.num,10);
});
test('explicit bound aliases retain provenance; suggestions and fabricated translations are not aliases',()=>{
  const a={...artist('島民'),aliases:[
    {value:'islandman',profile_id:'1',cm_artist:'2',source:'curated_catalog_alias',sourceRecordId:'alias-row'},
    {value:'wrong-profile',profile_id:'3',cm_artist:'2',source:'catalog',sourceRecordId:'other'},
    {value:'unsourced',profile_id:'1',cm_artist:'2'}]};
  const plan=youtubeSearchPlan(a);
  assert.equal(plan.names.length,2);
  assert.equal(plan.names[1].sourceRecordId,'alias-row');
  assert.match(plan.request.q,/\("島民" OR "islandman"\)/u);
  const recorded=fixture.searches.find(r=>r.artist==='島民');
  const unresolved=rank(recorded,artist('島民'));
  assert.equal(unresolved.candidates[0].relevance.bucket,'ambiguous');
  assert.equal(unresolved.candidates[0].relevance.matchedNames.length,0);
  const aliasRank=rank(recorded,a);
  assert.equal(aliasRank.candidates[0].relevance.matchedNames[0].kind,'declared_alias');
  assert.equal(aliasRank.candidates[0].verified,false);
});
test('Topic channels are separated from ordinary channels, even when ranked first',()=>{
  const row=fixture.searches.find(r=>r.artist==='Victor Aupecle'),a=artist(row.artist);
  const result=rank(row,a,2);
  assert.equal(result.topicCandidates.length,1);
  assert.equal(result.candidates.length,1);
  assert.ok(!result.candidates[0].title.includes('Topic'));
  const topicOnly=rank({organic:[row.organic[0]]},a);
  assert.equal(topicOnly.outcome,'topic_only');
  assert.equal(topicOnly.candidates.length,0);
  assert.equal(topicOnly.channelAbsenceProven,false);
});
test('ranking precedes the two-candidate limit and preserves all original evidence',()=>{
  const organic=[
    {title:'Bob Ross',link:'https://youtube.com/@bobross',snippet:'Painting tutorials'},
    {title:'Unresolved alias',link:'https://youtube.com/@other',snippet:'Music'},
    {title:'Pencing',link:'https://youtube.com/@pencing',snippet:'Official music'},
    {title:'Pencing live',link:'https://youtube.com/@pencinglive',snippet:'Songs'}];
  const result=rank({organic});
  assert.deepEqual(result.candidates.map(c=>c.title),['Pencing','Pencing live']);
  assert.equal(result.allSearchCandidates.length,4);
  assert.equal(result.candidates[0].relevance.originalRank,3);
  assert.equal(result.offTargetCandidates.length,1);
  assert.throws(()=>rank({organic},artist(),11),/limit/);
});
test('bound releases and label context break relevance ties but never establish identity',()=>{
  const a={...artist('Blue'),context:{chartmetric:{cm_artist:'2',label:'Small Label',code2:'AU'}},
    releases:[{cm_artist:'2',track_name:'My Release',source:'catalog_track'},
      {cm_artist:'3',track_name:'Wrong Release'}]};
  const plan=youtubeSearchPlan(a);
  assert.ok(plan.context.some(c=>c.value==='My Release'));
  assert.ok(!plan.context.some(c=>c.value==='Wrong Release'));
  const result=rank({organic:[
    {title:'Blue',link:'https://youtube.com/@bigblue',snippet:'Music'},
    {title:'Blue',link:'https://youtube.com/@smallblue',snippet:'My Release, Small Label music'}]},a);
  assert.equal(result.candidates[0].url,'https://www.youtube.com/@smallblue');
  assert.equal(result.candidates[0].relevance.ownershipProven,false);
  assert.throws(()=>youtubeSearchPlan({...a,catalogProfile:{profile_id:'wrong',cm_artist:'2'}}),/exact catalog/);
  const unbound=youtubeSearchPlan({...a,context:{chartmetric:{cm_artist:'3',name:'Fake alias',label:'Fake Label'}}});
  assert.ok(!unbound.names.some(n=>n.value==='Fake alias'));
  assert.ok(!unbound.context.some(n=>n.value==='Fake Label'));
});
test('short names match whole terms, and missing organic results fail rather than mean no-match',()=>{
  const result=rank({organic:[{title:'BODF music',link:'https://youtube.com/@bodf'}]},artist('ODF'));
  assert.equal(result.candidates[0].relevance.bucket,'ambiguous');
  assert.throws(()=>rank({error:'provider failure'}),/Missing organic/);
  assert.equal(rank({organic:[]}).searchStatus,'no_match');
});
test('catalog handles and alternate names are traceable, bounded and not confirmed identity aliases',()=>{
  const a={...artist('島民'),context:{chartmetric:{cm_artist:'2',name:'Alternate catalog name'}},
    accounts:[
      {profile_id:'1',cm_artist:'2',account_id:'3',platform:'lastfm',
        account_url:'https://www.last.fm/music/islandman',handle:'islandman',source:'catalog_link'},
      {profile_id:'9',cm_artist:'2',platform:'lastfm',handle:'Wrong',
        account_url:'https://www.last.fm/music/Wrong'},
      {profile_id:'1',cm_artist:'2',platform:'spotify',handle:'not-an-alias',
        account_url:'https://open.spotify.com/artist/abcdefghijklmnopqrstuv'}]};
  const plan=youtubeSearchPlan(a);
  assert.equal(plan.names.length,3);
  assert.equal(plan.names[2].kind,'catalog_account_handle_not_confirmed_alias');
  assert.equal(plan.names[2].accountId,'3');
  assert.equal(plan.queryNames.length,3);
  assert.equal(plan.names[1].source,'new_vertical.cm_artist');
  assert.ok(!plan.request.q.includes('Wrong'));
  assert.ok(!plan.request.q.includes('not-an-alias'));
  const spotifyPlan=youtubeSearchPlan({...a,releases:[
    {spotify_artist_id:'abcdefghijklmnopqrstuv',track_name:'Bound release'},
    {spotify_artist_id:'different',track_name:'Unbound release'}]});
  assert.deepEqual(spotifyPlan.context.map(c=>c.value),['Bound release']);
});
test('all three future entry points bind the policy and keep existing request and candidate caps',async()=>{
  for(const name of ['run-youtube-bounded-test','run-youtube-campaign','youtube-discovery-test']){
    const source=await fs.readFile(new URL('./'+name+'.mjs',import.meta.url),'utf8');
    assert.match(source,/youtubeSearchPlan\(/);
    assert.match(source,/rankYoutubeSearchCandidates\(/);
    assert.match(source,/assert.equal\((?:scope|approval).discoveryPolicyVersion,1/);
    assert.ok(!source.includes('artist official YouTube channel'));
  }
  const bounded=await fs.readFile(new URL('./run-youtube-bounded-test.mjs',import.meta.url),'utf8');
  assert.match(bounded,/rankYoutubeSearchCandidates\([^\n]+\{limit:2\}/);
  assert.match(bounded,/const size=boundedTestSize\(scope\)/);
  assert.match(bounded,/assert.equal\(scope.userCapCents,size.capCents\)/);
  assert.match(bounded,/\.sort\(\(a,b\)=>a\.tier-b\.tier\|\|a\.ordinal-b\.ordinal\)\.slice\(0,count\)/);
  assert.match(bounded,/assert.equal\(scope.candidatesPerArtist,2\)/);
  const campaign=await fs.readFile(new URL('./run-youtube-campaign.mjs',import.meta.url),'utf8');
  assert.match(campaign,/'scripts\/src\/youtube-search-plan.mjs'/);
});
test('incoming bound Spotify names and formatting aliases remain usable without proving ownership',()=>{
  const a={...artist('deepcurrent'),context:{spotify:[
    {profile_id:'1',usableAsContext:true,account_id:'spotify-id',latest:['Other Display Name']},
    {profile_id:'9',usableAsContext:true,account_id:'wrong',latest:['Wrong Profile']}]}}
  const plan=youtubeSearchPlan(a);
  const alias=plan.names.find(n=>n.value==='Other Display Name');
  assert.equal(alias.source,'bound_catalog_spotify_name');
  assert.equal(alias.accountId,'spotify-id');
  assert.match(alias.sourceRecordSha256,/^[a-f0-9]{64}$/);
  assert.ok(!plan.names.some(n=>n.value==='Wrong Profile'));
  const result=rank({organic:[{title:'Deep Current - Official',link:'https://youtube.com/@deepcurrent',snippet:'Songs'}]},a);
  assert.equal(result.candidates[0].relevance.matchedNames[0].value,'deepcurrent');
  assert.equal(result.candidates[0].relevance.ownershipProven,false);
});
