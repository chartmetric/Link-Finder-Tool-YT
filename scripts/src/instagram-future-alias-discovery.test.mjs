import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {instagramSearchCandidates} from './instagram-search-clues.mjs';
import {prepareSavedAlternativeScope,validateSavedAlternativeScope,digest,enrichedRequest} from './instagram-next-saved-batch.mjs';
const url='https://www.instagram.com/other_person/';
const alias='https://www.instagram.com/alex_synth/';
const artist='Cedar Signal';
const hit={link:url,title:'Other Person',snippet:"Cedar Signal’s (a.k.a. @alex_synth) record returns"};
const saved=()=>instagramSearchCandidates([hit],artist);
test('fresh searches opt into explicit aliases without promoting ownership or changing queries',()=>{
  assert.deepEqual(saved().map(c=>c.url),[url]);
  const found=instagramSearchCandidates([hit],artist,{explicitAliases:true});
  assert.equal(found[0].url,alias);
  assert.equal(found[0].discoveryEvidence[0].ownershipConfirmed,false);
  assert.equal(found[0].verified,undefined);
});
test('retained search provenance can expand a newly prepared candidate set without changing input',()=>{
  const original=saved(),before=JSON.stringify(original);
  const found=instagramSearchCandidates([],artist,{explicitAliases:true,savedCandidates:original});
  assert.deepEqual(found.map(c=>c.url),[alias,url]);
  assert.equal(JSON.stringify(original),before);
  const again=instagramSearchCandidates([],artist,{explicitAliases:true,savedCandidates:found});
  assert.deepEqual(again,found);
});
test('bare snippets and unrelated mentions do not fabricate search provenance or aliases',()=>{
  for(const pool of [[{url,title:'Other Person',snippet:hit.snippet}],
    [{url,discoveryEvidence:[{kind:'candidate_bio',sourceUrl:url,snippet:hit.snippet}]}]]){
    const found=instagramSearchCandidates([],artist,{explicitAliases:true,savedCandidates:pool});
    assert.deepEqual(found.map(c=>c.url),[url]);
  }
  assert.throws(()=>instagramSearchCandidates([],artist,{explicitAliases:true,savedCandidates:{}}),/Invalid saved/);
  assert.throws(()=>instagramSearchCandidates([],artist,{explicitAliases:true,
    savedCandidates:[{url,discoveryEvidence:{}}]}),/Invalid saved search provenance/);
});
test('new aliases are frozen before scope approval and cannot be inserted into an existing scope',()=>{
  const original=saved(),expanded=instagramSearchCandidates([],artist,{explicitAliases:true,savedCandidates:original});
  const target=candidates=>({profileId:'1',artist,sourceCapturedAt:'2026-11-11',
    player:{profile_id:'1',cm_artist:'2',artist,source_identity_matches:true,accounts:[],account_ids:[],
      catalog_profile:{profile_id:'1',cm_artist:'2'},savedCandidateUrls:candidates.map(c=>c.url)},
    candidates,selected:candidates[0],context:{ownershipConfirmed:false,items:[]}});
  const authorization={approved:true,budgetId:'fixture-budget',maxSpendCents:100,
    candidateMetadataFetchesApproved:true};
  const old=target(original),next=target(expanded);
  const oldScope=prepareSavedAlternativeScope([old],authorization);
  const nextScope=prepareSavedAlternativeScope([next],authorization);
  assert.notEqual(digest(oldScope),digest(nextScope));
  const amended=structuredClone(oldScope);
  amended.targets[0].candidates.push(expanded[0]);
  assert.throws(()=>validateSavedAlternativeScope(amended),/Unbound saved candidate scope/);
  assert.deepEqual(oldScope.targets[0].candidates.map(c=>c.url),[url]);
  assert.deepEqual(old.player.savedCandidateUrls,[url]);
  assert.deepEqual(next.player.savedCandidateUrls,[alias,url]);
  assert.equal(next.candidates[0].discoveryEvidence[0].ownershipConfirmed,false);
  const built=enrichedRequest(next,{url:alias,displayName:'Alex Synth',bio:'Captured account bio',externalUrls:[]});
  assert.equal(built.body.state.candidates[0].candidate.displayName,'Alex Synth');
  assert.equal(built.body.state.candidates[0].candidate.bio,'Captured account bio');
  assert.deepEqual(built.body.state.candidates[0].observedExactCatalogLinks,[]);
  assert.deepEqual(built.body.state.catalogAccountEvidence.accounts,[]);
});
test('new-run entry points enable aliases, but do not import the mention-only proposal',async()=>{
  for(const name of ['campaign-parallel-adapters','run-instagram-tier-priority','instagram-next-saved-batch']){
    const source=await fs.readFile(new URL('./'+name+'.mjs',import.meta.url),'utf8');
    assert.match(source,/explicitAliases:true/,name);
    assert.match(source,/savedCandidates:(?:target\.)?candidates/,name);
    assert.doesNotMatch(source,/instagram-mention-review-proposal|proposeMentionReview/,name);
  }
});
