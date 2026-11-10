import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {postReleaseSignals} from './instagram-post-signals.mjs';
import {instagramSearchCandidates} from './instagram-search-clues.mjs';
import {jevRequest,fitArtistContext,createLiveTransport} from './instagram-pilot-live-transport.mjs';
import {assessInstagramCandidates} from './musician-instagram-matching.mjs';
import {runFixturePilot} from './instagram-pilot-runner.mjs';

const url='https://www.instagram.com/example.artist/';
const spotify='https://open.spotify.com/artist/0123456789ABCDEFGHIJKL';
const reference={url:spotify,platform:'spotify',displayName:'Example Artist',externalUrls:[]};
const candidate={url,platform:'instagram',displayName:'Example Artist',bio:'',externalUrls:[]};
const context=(title='Midnight Harbor')=>({ownershipConfirmed:false,items:[{
  kind:'release',text:`${title} — Album (2026-01-01)`,source:'catalog_tracks',
  sourceUrl:spotify,asOf:'2026-01-02',stale:false,
}]});
const evidence=(text='Midnight Harbor out now',extra={})=>({
  kind:'post_caption_owner',sourceUrl:'https://www.instagram.com/reel/POST/',
  title:'New music',snippet:`42 likes - example.artist on November 1, 2026: ${text}`,
  date:'Nov 1, 2026',observedAt:'2026-11-10T00:00:00Z',ownershipConfirmed:false,...extra,
});
const profile=(discoveryEvidence=[evidence()],c=candidate)=>({url,discoveryEvidence,
  identityComparison:{reference,candidate:c,status:'uncertain'}});
const payload=(profiles=[profile()],ctx=context())=>({
  artist:'Example Artist',catalogReference:reference,profiles,artistContext:ctx,
});

test('release titles and hashtags match across languages without guessing from substrings',()=>{
  for(const [title,text,match] of [
    ['Midnight Harbor','Midnight Harbor out now','title_text'],
    ['Nasza Noc','#NaszaNoc','hashtag'],
    ['Corazón Azul','#Corazon_Azul','title_text'],
    ['Ночная музыка','#НочнаяМузыка','hashtag'],
    ['夜明けのメロディー','夜明けのメロディー','title_text'],
    ['별빛아래에서','#별빛아래에서','title_text'],
    ['月光下的旋律','#月光下的旋律','title_text'],
  ]){
    const result=postReleaseSignals(context(title),candidate,[evidence(text)]);
    assert.equal(result.result,'support',title);
    assert.equal(result.matches[0].match,match,title);
    assert.equal(result.matches[0].attribution,'candidate_owned_post_search_snippet');
  }
  for(const [title,text] of [['Home','Home'],['Nasza Noc','naszanocsomethingelse'],['Midnight Harbor','Midnight Harbors']]){
    assert.equal(postReleaseSignals(context(title),candidate,[evidence(text)]).matches.length,0);
  }
});

test('source provenance, source dates and uncertainty survive the actual verifier serializer',()=>{
  const p=payload(),before=structuredClone(p);
  const signal=jevRequest(p).state.artistContext.candidateSignals[0].songTitlesInCandidatePosts;
  const m=signal.matches[0];
  assert.equal(m.sourceUrl,p.profiles[0].discoveryEvidence[0].sourceUrl);
  assert.equal(m.snippet,p.profiles[0].discoveryEvidence[0].snippet);
  assert.equal(m.publishedAt,'Nov 1, 2026');
  assert.equal(m.observedAt,'2026-11-10T00:00:00Z');
  assert.equal(m.releaseSource.sourceUrl,spotify);
  assert.match(signal.note,/not ownership proof/);
  assert.deepEqual(p,before);
  const unknown=postReleaseSignals(context(),candidate,[evidence('Midnight Harbor',{date:undefined,observedAt:undefined})]);
  assert.equal(unknown.matches[0].publishedAt,null);
  assert.equal(unknown.matches[0].observedAt,null);
  assert.equal(jevRequest(payload([profile([],candidate)])).state.artistContext.candidateSignals[0].songTitlesInCandidatePosts,undefined);
});

test('owner attribution is recomputed, separating third-party mentions, missing and conflicting owners',()=>{
  const cases=[
    [evidence('Midnight Harbor',{snippet:'25 likes - someone_else on Monday: Midnight Harbor @example.artist',kind:'post_mention'}),'third_party_post'],
    [evidence('Midnight Harbor',{snippet:'Midnight Harbor @example.artist',kind:'post_mention'}),'unconfirmed'],
    [evidence('Midnight Harbor',{sourceUrl:'https://www.instagram.com/someone_else/reel/POST/'}),'conflicting_owner_clues'],
    [evidence('Midnight Harbor',{sourceUrl:'https://www.instagram.com.evil.test/reel/POST/'}),'unconfirmed'],
    [evidence('Midnight Harbor',{sourceUrl:'https://www.instagram.com/example.artist/reel/POST/',snippet:'Midnight Harbor'}),'candidate_owned_post_search_snippet'],
  ];
  for(const [e,expected] of cases){
    const result=postReleaseSignals(context(),candidate,[e]);
    assert.equal(result.matches[0].attribution,expected);
    if(expected!=='candidate_owned_post_search_snippet')assert.equal(result.result,'no_information');
  }
  const mismatched=profile([evidence()],{...candidate,url:'https://www.instagram.com/other/'});
  assert.equal(jevRequest(payload([mismatched])).state.artistContext.candidateSignals[0].songTitlesInCandidatePosts,undefined);
});

test('fan, cover, mashup, label and collaborator clues remain contextual in multiple languages',()=>{
  for(const phrase of ['fan-made video','fan page','tribute','homenaje','hommage','fanowski',
    '粉丝','ファンメイド','팬메이드','cover','mashup','remix','кавер','翻唱','カバー','커버',
    'feat. @someone','avec @someone','con @someone','совместно','record label','discográfica','wytwórnia']){
    const result=postReleaseSignals(context(),candidate,[evidence(`Midnight Harbor ${phrase}`)]);
    assert.equal(result.result,'no_information',phrase);
    assert.ok(result.matches[0].cautions.length,phrase);
  }
  const label=postReleaseSignals(context(),{...candidate,bio:'Record label representing many musicians'},[evidence()]);
  assert.ok(label.matches[0].cautions.includes('collaboration_or_credit'));
  assert.equal(label.result,'no_information');
});

test('title consistency never supplies a catalog cross-link or bypasses the 0.90 acceptance gate',()=>{
  const artist={profile_id:'1',artist:'Example Artist',account_ids:['7'],
    accounts:[{account_id:'7',platform:'spotify',account_url:spotify}]};
  const assess=p=>assessInstagramCandidates({methodsUsed:[{method:'serper',status:'used'}],profiles:[p]},artist);
  const p={...profile(),jevVerification:{verdict:'verified',sameIdentityProbability:0.99}};
  assert.deepEqual(assess(p).urls,[]);
  const linked={...p,identityComparison:{...p.identityComparison,status:'likely',
    candidate:{...candidate,externalUrls:[spotify]}},jevVerification:{verdict:'verified',sameIdentityProbability:0.89}};
  assert.deepEqual(assess(linked).urls,[]);
  assert.deepEqual(assess({...linked,jevVerification:{verdict:'verified',sameIdentityProbability:0.90}}).urls,[url]);
  // An unrelated entity can use precisely the same title without establishing identity.
  assert.deepEqual(assess({...p,identityComparison:{...p.identityComparison,
    candidate:{...candidate,displayName:'Other Entity',bio:'Fan page'}}}).urls,[]);
});

test('bounded scanning, deduplication, clipping and omitted records are explicit',()=>{
  const records=Array.from({length:45},(_,i)=>evidence('Midnight Harbor',{sourceUrl:`https://www.instagram.com/p/P${i}/`}));
  const s=postReleaseSignals(context(),candidate,records);
  assert.equal(s.matches.length,3);
  assert.deepEqual(s.diagnostics,{availableEvidence:45,inspectedEvidence:40,uninspectedEvidence:5,
    truncatedEvidence:0,matchedRecords:40,retainedRecords:3,omittedRecords:37});
  assert.equal(postReleaseSignals(context(),candidate,[evidence(),evidence()]).matches.length,1);
  const clipped=postReleaseSignals(context(),candidate,[evidence('Midnight Harbor '+ 'x'.repeat(2000))]);
  assert.equal(clipped.matches[0].textTruncated,true);
  assert.equal(clipped.diagnostics.truncatedEvidence,1);
  assert.equal(clipped.matches[0].snippet.length,1200);
  assert.throws(()=>postReleaseSignals(context(),candidate,[],4),/Invalid bounded/);
});

test('fitting prioritizes matched releases and audits post omissions within full serialized byte cap',()=>{
  const ctx=context();
  ctx.items.push({kind:'genre',source:'catalog',text:'x'.repeat(3000)});
  const p=payload([profile([evidence(),evidence('Midnight Harbor',{sourceUrl:'https://www.instagram.com/p/SECOND/'})])],ctx);
  const before=structuredClone(p);
  const fitted=fitArtistContext(p,6000),body=jevRequest(fitted);
  assert.ok(Buffer.byteLength(JSON.stringify(body))<=6000);
  assert.equal(body.state.contextDelivery.matchedPostRecords,2);
  assert.equal(body.state.contextDelivery.retainedPostRecords,2);
  assert.equal(body.state.contextDelivery.omittedPostRecords,0);
  assert.ok(fitted.artistContext.items.some(i=>i.kind==='release'));
  const compactBase=Buffer.byteLength(JSON.stringify(jevRequest({...p,compactEvidence:true,
    artistContext:context(),postEvidenceLimit:0})));
  const reduced=fitArtistContext(p,compactBase+300);
  assert.ok(Buffer.byteLength(JSON.stringify(jevRequest(reduced)))<=compactBase+300);
  assert.ok(reduced.contextDelivery.omittedPostRecords>0);
  assert.equal(reduced.contextDelivery.matchedPostRecords,
    reduced.contextDelivery.retainedPostRecords+reduced.contextDelivery.omittedPostRecords);
  assert.throws(()=>fitArtistContext(p,200),/no dispatch or silent evidence loss/);
  assert.deepEqual(p,before);
  const transport=createLiveTransport({keys:{SERPERDEV_API_KEY:'fixture',SCRAPECREATORS_API_KEY:'fixture',OPENROUTER_API_KEY:'fixture'},
    responseDir:'.',fetchImpl:()=>{throw Error('Network forbidden');}});
  assert.equal(transport.inputBytes({kind:'jev',payload:fitted}),Buffer.byteLength(JSON.stringify(body)));
});

test('search clues preserve dates and do not relabel collaborator mentions as post owners',()=>{
  const hits=[{link:'https://www.instagram.com/p/POST/',title:'Music',
    snippet:'12 likes - someone_else on Monday: Midnight Harbor @example.artist',date:'2 days ago',observedAt:'2026-11-10'}];
  const found=instagramSearchCandidates(hits,'Example Artist');
  const mention=found.find(p=>p.url===url).discoveryEvidence[0];
  assert.equal(mention.date,'2 days ago');
  assert.equal(mention.observedAt,'2026-11-10');
  assert.equal(mention.kind,'post_mention');
  assert.equal(postReleaseSignals(context(),candidate,[mention]).matches[0].attribution,'third_party_post');
});

test('bulk fixture delivers first-search post evidence even when a second search returns the same account',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'post-context-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const artist={profile_id:'1',cm_artist:'100',artist:'Example Artist',
    catalog_profile:{profile_id:'1',cm_artist:'100',cm_source:'cm_artist'},source_identity_matches:true,
    reference_preflight:{readiness:'reference_usable'},account_ids:['7'],
    accounts:[{account_id:'7',platform:'spotify',account_url:spotify}],metadata_context:context()};
  const manifest={run_allowed:false,artists:[artist],proposed_limits:{
    artist_workers:1,global_concurrent_provider_requests:1,eligible_artists_before_prerequisite_fixes:1,
    serper_requests_per_artist:2,instagram_candidate_metadata_per_artist:1,reference_metadata_per_artist:1,
    jev_requests_per_artist:1,serper_requests_total:2,scrapecreators_requests_total:1,jev_requests_total:1,
    paid_http_requests_total:4,public_spotify_oembed_requests_total:1,public_official_or_linkhub_page_requests_total:1,
    per_request_timeout_seconds:20,per_artist_wall_time_seconds:60,job_wall_time_minutes:1,
    jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000}};
  const calls=[];let decision;
  const results=await runFixturePilot({manifest,journalPath:path.join(dir,'admissions.jsonl'),
    transport:{fixture:true,dispatch:async({kind,payload:p})=>{
      calls.push(kind);
      if(kind==='spotify_oembed')return reference;
      if(kind==='serper')return {methodsUsed:[{method:'serper',status:'used'}],profiles:[
        {url,discoveryEvidence:p.queryIndex===0?[evidence()]:[{kind:'direct_profile',sourceUrl:url,title:'Example Artist'}]}]};
      if(kind==='scrapecreators_candidate')return candidate;
      if(kind==='jev'){
        decision=jevRequest(p);
        return [{url,jevVerification:{verdict:'uncertain',sameIdentityProbability:0.6}}];
      }
      throw Error('Unexpected provider kind');
    }}});
  assert.deepEqual(calls,['spotify_oembed','serper','serper','scrapecreators_candidate','jev']);
  assert.equal(decision.state.artistContext.candidateSignals[0].songTitlesInCandidatePosts.matches.length,1);
  assert.equal(results.results[0].contextDelivery.retainedPostRecords,1);
  assert.deepEqual(results.results[0].urls,[]);
  assert.equal(results.results[0].approvedCatalogLinks,false);
});
