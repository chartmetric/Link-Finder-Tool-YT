import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {catalogReferences,instagramProfileUrl} from './musician-instagram-matching.mjs';
import {jevRequest,fitArtistContext} from './instagram-pilot-live-transport.mjs';
import {CORROBORATED_RUBRIC} from './instagram-ownership-rubric.mjs';
import {normalizeInstagramProfile} from './instagram-link-capture.mjs';
export const digest=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export async function prepareNextSavedBatch(dir,previous){
  const read=async f=>JSON.parse(await fs.readFile(path.join(dir,f),'utf8'));
  const discovery=(await Promise.all((await fs.readdir(dir)).filter(f=>/^discovery-\d+\.json$/.test(f)).sort().map(read))).flat();
  assert.equal(discovery.length,500);assert.equal(new Set(discovery.map(r=>r.profile_id)).size,500);
  const profiles=new Map((await read('frozen-profiles.json')).map(r=>[r.profile_id,r]));
  const accounts=new Map((await read('frozen-accounts.json')).map(r=>[r.profile_id,r.accounts]));
  const countries=new Map((await read('frozen-country.json')).map(r=>[String(r.cm_artist),r]));
  const priorIds=new Set(previous.artists.map(a=>String(a.profile_id))),priorCms=new Set(previous.artists.map(a=>String(a.cm_artist)));
  const targets=discovery.map(row=>{
    const p=profiles.get(row.profile_id);assert.ok(p);assert.equal(String(p.cm_artist),String(row.cm_artist));
    assert.ok(!priorIds.has(row.profile_id)&&!priorCms.has(String(row.cm_artist)),'Prior artist would be charged again.');
    const saved=JSON.parse(row.result_json),candidates=[],seen=new Set();
    for(const candidate of saved.profiles??[]){
      const url=instagramProfileUrl(candidate.url);
      if(url&&!seen.has(url)){candidates.push({...candidate,url});seen.add(url);}
    }
    const aa=(accounts.get(row.profile_id)??[]).map(([account_id,platform,account_url,handle])=>
      ({profile_id:row.profile_id,account_id,platform,account_url,handle}));
    const player={profile_id:row.profile_id,cm_artist:String(row.cm_artist),artist:p.name,tier_rank:row.tier_rank,
      accounts:aa,account_ids:aa.map(a=>a.account_id),source_identity_matches:true,catalog_profile:p,
      savedCandidateUrls:candidates.map(c=>c.url)};
    const country=countries.get(String(row.cm_artist));
    const context={ownershipConfirmed:false,items:country?.code2?[{kind:'country',source:'new_vertical.cm_artist',
      text:country.code2,asOf:p.source_updated_at,binding:'catalog_artist_identity_only',stale:false}]:[]};
    return {player,artist:p.name,profileId:row.profile_id,sourceCapturedAt:row.captured_at,
      sourceArtistName:row.artist,sourceRunEvidenceSha256:digest(row.result_json),
      candidates,selected:candidates[0]??null,context,catalogCountryRecord:country??null};
  });
  assert.equal(new Set(targets.map(t=>t.player.cm_artist)).size,500);
  return targets;
}
export function enrichedRequest(target,candidate){
  const ref=catalogReferences(target.player)[0]??{platform:'catalog',url:`https://app.chartmetric.com/artist/${target.player.cm_artist}`};
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
  const bytes=Buffer.byteLength(JSON.stringify(body));if(bytes>6000)throw Error('Complete evidence exceeds 6000 bytes.');
  return {profile,body,bytes,sha256:digest(body)};
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
