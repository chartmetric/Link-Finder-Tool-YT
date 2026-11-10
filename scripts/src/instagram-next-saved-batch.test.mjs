import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {enrichedRequest,capturedInstagramTransport,digest} from './instagram-next-saved-batch.mjs';
import {catalogBoundReviewSuggestion,likelyReviewSuggestion} from './instagram-likely-review-policy.mjs';
const url='https://www.instagram.com/test_artist/';
const target={artist:'Catalog Artist',profileId:'42',sourceCapturedAt:'2026-11-04',sourceArtistName:'Old stage name',
  selected:{url,title:'Google result title, not a display name',snippet:'Saved search snippet, not a bio'},
  player:{profile_id:'42',cm_artist:'123',artist:'Catalog Artist',accounts:[],account_ids:[],source_identity_matches:true,
    catalog_profile:{profile_id:'42',cm_artist:'123'}},context:{ownershipConfirmed:false,items:[]}};
test('catalog-only references are explicit and cannot become artist-owned external profile evidence',()=>{
  const candidate={url,displayName:'Artist',bio:'Actual captured biography',externalUrls:[],directExternalUrls:[]};
  const built=enrichedRequest(target,candidate);
  assert.ok(built.bytes<=6000);assert.equal(built.body.state.savedSearchEvidence.snippet,target.selected.snippet);
  assert.match(built.body.state.catalogReferenceNote,/not a newly captured/);
  assert.equal(built.profile.identityComparison.candidate.bio,candidate.bio);
  built.profile.jevVerification={verdict:'likely',sameIdentityProbability:0.4};
  assert.equal(likelyReviewSuggestion(built.profile,target.player).reviewSuggestion,false);
  const r=catalogBoundReviewSuggestion(built.profile,target.player);
  assert.equal(r.reviewSuggestion,true);assert.equal(r.verified,false);
  const foreign=structuredClone(target.player);foreign.catalog_profile.cm_artist='456';
  assert.equal(catalogBoundReviewSuggestion(built.profile,foreign).reviewSuggestion,false);
});
test('metadata transport only fetches frozen Instagram handles, binds returned usernames, and stops on billing failure',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'next-saved-metadata-'));
  let calls=0;
  const body={url},request={kind:'scrapecreators_candidate',key:'test',payload:{body,inputSha256:digest(body)}};
  try{
    const transport=capturedInstagramTransport({apiKey:'fixture-not-secret',responseDir:dir,fetchImpl:async u=>{
      calls++;assert.equal(u.hostname,'api.scrapecreators.com');assert.equal(u.searchParams.get('handle'),'test_artist');
      return Response.json({data:{user:{username:'test_artist',full_name:'Artist',biography:'Actual bio',external_url:null,bio_links:[]}}});
    }});
    const result=await transport.dispatch(request);
    assert.equal(result.available,true);assert.equal(result.costBasis,'conservative_metadata_estimate');assert.equal(calls,1);
    const failed=capturedInstagramTransport({apiKey:'fixture',responseDir:dir,fetchImpl:async()=>Response.json({message:'insufficient credits'},{status:402})});
    await assert.rejects(failed.dispatch({...request,key:'funding'}),/funding/);
    const wrong=capturedInstagramTransport({apiKey:'fixture',responseDir:dir,fetchImpl:async()=>Response.json({data:{user:{username:'someone_else'}}})});
    assert.equal((await wrong.dispatch({...request,key:'wrong'})).available,false);
    const missing=capturedInstagramTransport({apiKey:'fixture',responseDir:dir,fetchImpl:async()=>Response.json({success:false,message:'Profile not found'},{status:404})});
    assert.equal((await missing.dispatch({...request,key:'missing'})).available,false);
    const privateProfile=capturedInstagramTransport({apiKey:'fixture',responseDir:dir,fetchImpl:async()=>Response.json({
      success:true,error:'not_found',errorStatus:404,message:'Profile is private',
      data:{user:{username:'test_artist',full_name:'Artist',biography:'Public profile biography',external_url:null,bio_links:[]}}})});
    const privateResult=await privateProfile.dispatch({...request,key:'private'});
    assert.equal(privateResult.available,true);assert.equal(privateResult.candidate.bio,'Public profile biography');
    assert.equal(privateResult.accessState,'profile_metadata_available_content_restricted');
    const unrelatedFailure=capturedInstagramTransport({apiKey:'fixture',responseDir:dir,continueAcknowledgedServerErrors:true,
      fetchImpl:async()=>Response.json({success:true,error:'not_found',message:'Profile is private',data:{user:{username:'another_person',full_name:'Artist'}}})});
    assert.equal((await unrelatedFailure.dispatch({...request,key:'private-wrong-identity'})).available,false);
    let attempts=0;
    const knownFailure=capturedInstagramTransport({apiKey:'fixture',responseDir:dir,continueAcknowledgedServerErrors:true,
      fetchImpl:async()=>{attempts++;return Response.json({message:'Temporary server failure'},{status:500});}});
    const held=await knownFailure.dispatch({...request,key:'known-server-error'});
    assert.equal(held.available,false);assert.equal(attempts,1);assert.equal(held.httpStatus,500);
    const funding=capturedInstagramTransport({apiKey:'fixture',responseDir:dir,continueAcknowledgedServerErrors:true,
      fetchImpl:async()=>Response.json({message:'Insufficient credits'},{status:500})});
    await assert.rejects(funding.dispatch({...request,key:'server-funding'}),/funding/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
