import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {instagramProfileUrl} from './musician-instagram-matching.mjs';
import {jevRequest,fitArtistContext} from './instagram-pilot-live-transport.mjs';
import {CORROBORATED_RUBRIC} from './instagram-ownership-rubric.mjs';
import {normalizeInstagramProfile} from './instagram-link-capture.mjs';
import {readSavedDiscovery,readVerifiedSavedSources} from './instagram-saved-source-export.mjs';
import {catalogAccountContext} from './instagram-catalog-account-context.mjs';
export const digest=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export async function prepareNextSavedBatch(dir,previous,{expectedArtists=500}={}){
  assert.ok(Number.isInteger(expectedArtists)&&expectedArtists>0&&expectedArtists<=500);
  const savedDiscovery=await readSavedDiscovery(dir),discovery=savedDiscovery.rows;
  assert.equal(discovery.length,expectedArtists);assert.equal(new Set(discovery.map(r=>r.profile_id)).size,expectedArtists);
  const sources=await readVerifiedSavedSources(dir,savedDiscovery);
  const profiles=new Map(sources.catalogProfiles.map(r=>[r.profile_id,r]));
  const accounts=new Map();
  for(const a of sources.accounts){
    const list=accounts.get(a.profile_id)??[];list.push(a);accounts.set(a.profile_id,list);
  }
  const countries=new Map(sources.chartmetric.map(r=>[String(r.cm_artist),r]));
  const priorIds=new Set(previous.artists.map(a=>String(a.profile_id))),priorCms=new Set(previous.artists.map(a=>String(a.cm_artist)));
  const targets=discovery.map(row=>{
    const id=String(row.profile_id);
    const p=profiles.get(id);assert.ok(p);assert.equal(String(p.cm_artist),String(row.cm_artist));
    assert.ok(!priorIds.has(id)&&!priorCms.has(String(row.cm_artist)),'Prior artist would be charged again.');
    const saved=JSON.parse(row.result_json),candidates=[],seen=new Set();
    for(const candidate of saved.profiles??[]){
      const url=instagramProfileUrl(candidate.url);
      if(url&&!seen.has(url)){candidates.push({...candidate,url});seen.add(url);}
    }
    const allAccounts=accounts.get(id)??[];
    const aa=allAccounts.filter(a=>typeof a.account_url==='string'&&a.account_url.trim());
    const player={profile_id:id,cm_artist:String(row.cm_artist),artist:p.name,tier_rank:row.tier_rank,
      accounts:aa,account_ids:aa.map(a=>a.account_id),source_identity_matches:true,catalog_profile:p,
      source_export_sha256:sources.sourceExportSha256,
      savedCandidateUrls:candidates.map(c=>c.url)};
    const country=countries.get(String(row.cm_artist));
    const context={ownershipConfirmed:false,items:country?.code2?[{kind:'country',source:'new_vertical.cm_artist',
      text:country.code2,asOf:p.source_updated_at,binding:'catalog_artist_identity_only',stale:false}]:[]};
    return {player,artist:p.name,profileId:id,sourceCapturedAt:row.captured_at,
      sourceExportSha256:sources.sourceExportSha256,
      sourceArtistName:row.artist,sourceRunEvidenceSha256:digest(row.result_json),
      candidates,selected:candidates[0]??null,context,catalogCountryRecord:country??null,
      unusedCatalogAccounts:allAccounts.filter(a=>!aa.includes(a)).map(a=>({...a,
        exclusionReason:'missing_account_url_not_identity_evidence'}))};
  });
  assert.equal(new Set(targets.map(t=>t.player.cm_artist)).size,expectedArtists);
  return targets;
}
export function enrichedRequest(target,candidate){
  assert.equal(candidate?.url,target.selected?.url,'Captured metadata must match the exact selected account.');
  assert.ok(instagramProfileUrl(candidate.url)===candidate.url,'Invalid captured account URL.');
  const accountContext=catalogAccountContext(target.player,candidate.url);
  const ref=accountContext.accounts[0]??{platform:'catalog',url:`https://app.chartmetric.com/artist/${target.player.cm_artist}`};
  const profile={url:target.selected.url,identityComparison:{status:'uncertain',reference:{platform:ref.platform,url:ref.url},candidate}};
  const payload=fitArtistContext({artist:target.artist,catalogReference:ref,profiles:[profile],
    artistContext:target.context,ownershipRubric:CORROBORATED_RUBRIC},6000);
  if(payload.contextDelivery?.omittedItems||payload.contextDelivery?.omittedPostRecords)throw Error('Complete evidence did not fit.');
  const body=jevRequest({...payload,compactEvidence:true});
  body.state.savedSearchEvidence={source:'saved_musician_discovery',observedAt:target.sourceCapturedAt,
    artistNameAtCapture:target.sourceArtistName,title:target.selected.title??'',snippet:target.selected.snippet??'',
    url:target.selected.url,note:'Historical search text, not an account biography or ownership proof.'};
  body.state.catalogReferenceNote=ref.platform==='catalog'
    ?'This is an ID-bound catalog artist record, not a newly captured or artist-owned external profile.'
    :'Reference URL is frozen from the catalog; reference-page ownership and biography were not newly fetched.';
  body.state.catalogAccountEvidence=accountContext;
  const bytes=Buffer.byteLength(JSON.stringify(body));if(bytes>6000)throw Error('Complete evidence exceeds 6000 bytes.');
  return {profile,body,bytes,sha256:digest(body)};
}

// Freezing this object is preparation, not permission to execute. The caller
// must supply a NEW explicit authorization; existing scopes are never amended.
export function prepareSavedAlternativeScope(targets,authorization,{inspectAlternatives=false,expectedModel='typesafe/jev-1.13-20260917'}={}){
  const scope={version:'saved-alternatives-v1',authorization:structuredClone(authorization),
    inspectSavedAlternatives:inspectAlternatives,targets:structuredClone(targets),expectedModel,
    savedEvidenceOnly:false,candidateMetadataFetchesApproved:true,newSearchesAllowed:false,
    publicPageFetchingAllowed:false,liveLinkWrites:false,automaticRetries:0};
  validateSavedAlternativeScope(scope);
  return scope;
}
export function validateSavedAlternativeScope(scope){
  const a=scope.authorization,targets=scope.targets;
  assert.ok(scope.version==='saved-alternatives-v1'&&a?.approved===true
    &&a.candidateMetadataFetchesApproved===true&&typeof a.budgetId==='string'&&a.budgetId.trim()
    &&Number.isInteger(a.maxSpendCents)&&a.maxSpendCents>=1&&a.maxSpendCents<=2000
    &&typeof scope.inspectSavedAlternatives==='boolean'
    &&(!scope.inspectSavedAlternatives||a.savedAlternativesApproved===true)
    &&scope.savedEvidenceOnly===false&&scope.candidateMetadataFetchesApproved===true
    &&scope.newSearchesAllowed===false&&scope.publicPageFetchingAllowed===false
    &&scope.liveLinkWrites===false&&scope.automaticRetries===0
    &&typeof scope.expectedModel==='string'&&scope.expectedModel.length>0
    &&Array.isArray(targets)&&targets.length>0&&targets.length<=500,'Invalid saved-alternative approval.');
  const ids=new Set(),cms=new Set();
  for(const t of targets){
    const p=t.player,id=String(t.profileId);
    assert.ok(p&&id===String(p.profile_id)&&!ids.has(id)&&!cms.has(String(p.cm_artist))
      &&p.source_identity_matches===true&&String(p.catalog_profile?.profile_id)===id
      &&String(p.catalog_profile?.cm_artist)===String(p.cm_artist)
      &&/^[1-9]\d*$/.test(String(p.cm_artist)),'Unbound or duplicate saved artist.');
    ids.add(id);cms.add(String(p.cm_artist));
    assert.ok(Array.isArray(t.candidates)&&Array.isArray(p.savedCandidateUrls),'Missing frozen saved candidates.');
    const urls=t.candidates.map(c=>c.url);
    assert.ok(new Set(urls).size===urls.length&&urls.every(u=>instagramProfileUrl(u)===u)
      &&digest(urls)===digest(p.savedCandidateUrls),'Unbound saved candidate scope.');
  }
}
export function capturedInstagramTransport({apiKey,responseDir,fetchImpl=fetch,continueAcknowledgedServerErrors=false}){
  if(!apiKey)throw Error('Missing Instagram provider credential.');
  return {live:true,dispatch:async({kind,key,payload,signal})=>{
    assert.equal(kind,'scrapecreators_candidate');
    assert.equal(digest(payload.body),payload.inputSha256);
    const canonical=instagramProfileUrl(payload.body.url);assert.equal(canonical,payload.body.url);
    const endpoint=new URL('https://api.scrapecreators.com/v1/instagram/profile');
    endpoint.searchParams.set('handle',new URL(canonical).pathname.split('/')[1]);
    const response=await fetchImpl(endpoint,{headers:{'x-api-key':apiKey},signal,redirect:'error'});
    const chunks=[];let bytes=0;
    if(response.body)for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2000000)throw Error('Oversized metadata response; no retry.');chunks.push(chunk);}
    const text=Buffer.concat(chunks).toString('utf8');let data;
    try{data=JSON.parse(text);}catch{throw Error('Invalid provider response; no retry.');}
    const redact=(k,v)=>/token|password|secret|api.?key|cookie|authorization/i.test(k)?'[redacted]':v;
    await fs.writeFile(path.join(responseDir,key+'.json'),JSON.stringify({at:new Date().toISOString(),
      status:response.status,requestedUrl:canonical,data},redact,2),{flag:'wx'});
    const message=JSON.stringify({error:data.error,message:data.message,errorStatus:data.errorStatus}).slice(0,5000);
    if(response.status===401||response.status===402||/insufficient.{0,30}(?:credit|balance)|(?:no|not enough|out of).{0,20}credits?|credits?.{0,30}(?:exhausted|depleted)|invalid.{0,12}api.?key/i.test(message))
      throw Error('Provider funding or authentication failure; stopped without retry.');
    if(response.status===429||Number(data.errorStatus)===429)throw Error('Metadata provider rate limit; stopped without retry.');
    if(response.status===404&&data.success===true&&data.error==='not_found'
      &&Number(data.errorStatus)===404&&data.message==='Profile is restricted'
      &&typeof data.handle==='string'&&data.handle.toLowerCase()===endpoint.searchParams.get('handle').toLowerCase())
      return {cost:0.02,costBasis:'conservative_metadata_estimate',available:false,
        reason:'confirmed_restricted_profile_not_retried',httpStatus:404};
    if(response.status===403&&data.success===true&&data.age_restricted===true
      &&typeof data.handle==='string'&&data.handle.toLowerCase()===endpoint.searchParams.get('handle').toLowerCase())
      return {cost:0.02,costBasis:'conservative_metadata_estimate',available:false,
        reason:'confirmed_age_restricted_profile_not_retried',httpStatus:403};
    if(continueAcknowledgedServerErrors&&response.status>=500&&response.status<=599)
      return {cost:0.02,costBasis:'conservative_metadata_estimate',available:false,
        reason:'acknowledged_provider_server_error_not_retried',httpStatus:response.status};
    const resourceLimited=(!response.ok||data.success===false||data.error)
      &&/profile.{0,25}(?:not found|private|unavailable|does not exist)|user.{0,20}not found|account.{0,25}(?:not found|unavailable)/i.test(message);
    if(resourceLimited){
      // Some successful provider responses flag private posts as unavailable
      // while still supplying a response-bound public biography and bio links.
      let candidate;try{candidate=normalizeInstagramProfile(data,canonical);}catch{}
      if(candidate&&(candidate.displayName||candidate.bio||candidate.externalUrls?.length))
        return {cost:0.02,costBasis:'conservative_metadata_estimate',available:true,candidate,
          accessState:'profile_metadata_available_content_restricted'};
      return {cost:0.02,costBasis:'conservative_metadata_estimate',available:false,reason:'profile_unavailable_or_restricted'};
    }
    if(continueAcknowledgedServerErrors&&response.ok&&(data.success===false||data.error))
      return {cost:0.02,costBasis:'conservative_metadata_estimate',available:false,reason:'acknowledged_provider_error_not_retried'};
    if(!response.ok||data.success===false||data.error)throw Error(`Metadata provider HTTP ${response.status}; no retry.`);
    let candidate;
    try{candidate=normalizeInstagramProfile(data,canonical);}
    catch{return {cost:0.02,costBasis:'conservative_metadata_estimate',available:false,reason:'unbound_or_conflicting_provider_identity'};}
    if(!candidate.displayName&&!candidate.bio)return {cost:0.02,costBasis:'conservative_metadata_estimate',available:false,reason:'profile_metadata_empty'};
    return {cost:0.02,costBasis:'conservative_metadata_estimate',available:true,candidate};
  }};
}
