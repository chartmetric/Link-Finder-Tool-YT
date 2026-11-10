import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {catalogReferences,instagramProfileUrl,catalogConnectionEvidence,hasCatalogCrossLink} from './musician-instagram-matching.mjs';
import {revisedProfile} from './instagram-saved-fix-rerun.mjs';
import {artistContextFromPacket} from './instagram-artist-metadata-overlay.mjs';
import {fitArtistContext,jevRequest} from './instagram-pilot-live-transport.mjs';
import {CORROBORATED_RUBRIC} from './instagram-ownership-rubric.mjs';
import {assertNoGradingInputs} from './instagram-corroborated-policy.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
const fold=s=>String(s??'').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const identity=a=>[a.profile_id&&`p:${a.profile_id}`,a.cm_artist&&`cm:${a.cm_artist}`,
  ...(a.account_ids??[]).map(id=>`a:${id}`),...(a.accounts??[]).flatMap(a=>[
    a.account_id&&`a:${a.account_id}`,a.account_url&&`u:${a.account_url.replace(/\/$/,'')}`])].filter(Boolean);
const quality=p=>Number(Boolean(p.identityComparison?.candidate?.displayName))*100
  +Number(Boolean(p.identityComparison?.candidate?.bio))*10
  +(p.identityComparison?.candidate?.externalLinkEvidence?.pages?.length??0);
const readable=p=>instagramProfileUrl(p.url)&&instagramProfileUrl(p.identityComparison?.candidate?.url)===instagramProfileUrl(p.url)
  &&p.identityComparison?.reference?.url&&p.identityComparison?.candidate?.displayName;

export function savedRequest(target,original){
  const p=revisedProfile(original,target.artist),ref=catalogReferences(target.artist)[0];
  if(!ref)throw Error('no_frozen_catalog_reference');
  p.identityComparison.reference=structuredClone(target.profile?.identityComparison?.reference??{url:ref.url,platform:ref.platform});
  if(p.identityComparison.reference.url!==ref.url)throw Error('reference_not_primary_catalog_bound');
  const payload=fitArtistContext({artist:target.artist.artist,catalogReference:ref,profiles:[p],
    artistContext:target.context,ownershipRubric:CORROBORATED_RUBRIC},6000);
  const body=jevRequest({...payload,compactEvidence:true}),bytes=Buffer.byteLength(JSON.stringify(body));
  assertNoGradingInputs(body.state);
  if(bytes>6000)throw Error('complete_evidence_exceeds_request_limit');
  if(body.state.contextDelivery?.omittedItems||body.state.contextDelivery?.omittedPostRecords)
    throw Error('complete_context_or_posts_would_be_omitted');
  return {body,bytes,sha256:sha(JSON.stringify(body)),profile:p};
}

export async function prepareSavedBulk({directories,outputDir}){
  const inputs=[],artists=new Map(),observations=[];
  const read=async f=>{const text=await fs.readFile(f,'utf8');inputs.push({file:f,sha256:sha(text)});return text;};
  for(const directory of directories){
    const manifest=JSON.parse(await read(path.join(directory,'approved-manifest.json')));
    const roster=new Map(manifest.artists.map(a=>[String(a.profile_id),a]));
    const contexts=new Map();
    const overlay=path.join(directory,'artist-context-evidence.json');
    try{
      const data=JSON.parse(await read(overlay));
      for(const packet of data.packets??[]){
        const a=roster.get(String(packet.profileId));
        if(!a||String(packet.cmArtist)!==String(a.cm_artist))throw Error('Saved metadata artist binding failed.');
        contexts.set(String(packet.profileId),artistContextFromPacket(packet));
      }
    }catch(e){if(e.code!=='ENOENT')throw e;}
    for(const a of roster.values()){
      const id=String(a.profile_id),prior=artists.get(id);
      if(prior&&String(prior.artist.cm_artist)!==String(a.cm_artist))throw Error('Conflicting frozen catalog identity.');
      artists.set(id,{artist:a,context:contexts.get(id)??a.metadata_context??{ownershipConfirmed:false,items:[]},
        archive:directory,profiles:prior?.profiles??new Map()});
    }
    for(const line of (await read(path.join(directory,'results.jsonl'))).split('\n').filter(s=>s.trim())){
      const row=JSON.parse(line),a=roster.get(String(row.profileId));if(!a)throw Error('Unbound result artist.');
      const entry=artists.get(String(row.profileId));
      for(const p of (row.rawResult??row.partialEvidence)?.profiles??[]){
        const url=instagramProfileUrl(p.url);if(!url)continue;
        const source={artist:a,context:contexts.get(String(a.profile_id))??a.metadata_context??{ownershipConfirmed:false,items:[]},
          archive:directory,profile:p};
        observations.push(source);
        const before=entry.profiles.get(url);
        if(!before||quality(p)>quality(before.profile))entry.profiles.set(url,source);
      }
    }
  }
  // Reserve five source artists for distinct control accounts. No model verdict,
  // score, supported answer or artist-name exception influences selection.
  const all=[...artists.values()],donorArtists=all.filter(e=>[...e.profiles.values()].some(x=>readable(x.profile)))
    .sort((a,b)=>[...b.profiles.values()].filter(x=>readable(x.profile)).length-[...a.profiles.values()].filter(x=>readable(x.profile)).length
      ||String(a.artist.profile_id).localeCompare(String(b.artist.profile_id))).slice(0,Math.max(0,all.length-500));
  const donorIds=new Set(donorArtists.map(e=>String(e.artist.profile_id)));
  const targets=all.filter(e=>!donorIds.has(String(e.artist.profile_id)))
    .sort((a,b)=>(a.artist.tier??99)-(b.artist.tier??99)||(a.artist.tier_rank??Infinity)-(b.artist.tier_rank??Infinity)
      ||String(a.artist.profile_id).localeCompare(String(b.artist.profile_id))).slice(0,500);
  const targetKeys=new Set(targets.flatMap(e=>identity(e.artist)));
  const targetNames=new Set(targets.map(e=>fold(e.artist.artist)));
  const targetUrls=new Set(targets.flatMap(e=>[...e.profiles.keys()]));
  const controlPool=donorArtists.flatMap(e=>[...e.profiles.values()]).filter(d=>{
    if(!readable(d.profile)||identity(d.artist).some(k=>targetKeys.has(k))||targetNames.has(fold(d.artist.artist))
      ||targetUrls.has(instagramProfileUrl(d.profile.url)))return false;
    return !targets.some(t=>catalogConnectionEvidence(d.profile.identityComparison.candidate,t.artist).length
      ||[...t.profiles.values()].some(o=>hasCatalogCrossLink(o.profile.identityComparison?.reference??{},
        d.profile.identityComparison.candidate,d.profile.url,
        {platform:o.profile.identityComparison?.reference?.platform,url:o.profile.identityComparison?.reference?.url})));
  }).sort((a,b)=>a.profile.url.localeCompare(b.profile.url));
  const requests=[],rows=[],controls=[],seenControls=new Set();
  for(const d of controlPool){
    const url=instagramProfileUrl(d.profile.url);if(seenControls.has(url))continue;
    for(const t of targets){
      try{
        const built=savedRequest({...t,profile:[...t.profiles.values()][0]?.profile},d.profile);
        controls.push({target:t,source:d,built});seenControls.add(url);break;
      }catch{}
    }
    if(controls.length===50)break;
  }
  if(controls.length<6)throw Error('Insufficient distinct non-target saved controls; no paid execution.');
  const add=(target,source,built,role)=>{
    const key=`${String(requests.length+1).padStart(4,'0')}-${role}`;
    const request={key,profileId:String(target.artist.profile_id),kind:'jev',role,
      artist:target.artist.artist,instagramUrl:instagramProfileUrl(source.profile.url),
      body:built.body,bytes:built.bytes,sha256:built.sha256};
    requests.push(request);
    rows.push({key,profileId:request.profileId,artist:request.artist,role,url:request.instagramUrl,
      sourceArtist:source.artist.artist,sourceProfileId:String(source.artist.profile_id),
      profile:built.profile,player:target.artist,context:target.context,status:'prepared'});
  };
  for(const c of controls)add(c.target,c.source,c.built,'control');
  const queues=[];
  for(const t of targets){
    const candidates=[...t.profiles.values()];
    if(!candidates.length)rows.push({profileId:String(t.artist.profile_id),artist:t.artist.artist,role:'candidate',
      status:'no_saved_candidate',reason:'No saved candidate; no new search performed. This does not prove no account exists.'});
    const queue=[];
    for(const source of candidates){
      try{
        if(!readable(source.profile))throw Error('saved_account_metadata_unavailable');
        const target={...t,profile:source.profile},built=savedRequest(target,source.profile);
        queue.push({target,source,built});
      }catch(e){rows.push({profileId:String(t.artist.profile_id),artist:t.artist.artist,role:'candidate',
        url:instagramProfileUrl(source.profile.url),status:'held_without_call',reason:e.message});}
    }
    queues.push(queue);
  }
  // Give every eligible artist a first request before additional candidates.
  for(let round=0;queues.some(q=>q.length>round);round++)for(const q of queues){
    const c=q[round];if(!c)continue;
    if(requests.length<1000)add(c.target,c.source,c.built,'candidate');
    else rows.push({profileId:String(c.target.artist.profile_id),artist:c.target.artist.artist,role:'candidate',
      url:instagramProfileUrl(c.source.profile.url),status:'held_without_call',reason:'approved_spending_limit'});
  }
  const scope={version:1,authorization:{approved:true,maxSpendCents:2000,
    budgetId:'saved-artists-500-approved-usd20-20261110',
    source:'User approved rechecking saved candidates, 500 artists, maximum $20.'},
    savedEvidenceOnly:true,liveLinkWrites:false,automaticRetries:0,
    expectedModel:'typesafe/jev-1.13-20260917',rubric:CORROBORATED_RUBRIC,
    artists:targets.map(t=>t.artist),requests,inputs,
    plannedControlAccounts:controls.length,controlSourceArtists:new Set(controls.map(c=>c.source.artist.profile_id)).size,
    controlsAreIndependentlyReviewedLabels:false,
    artistRecords:targets.length,sourceArtistRecords:all.length,
    distinctCandidateArtists:targets.filter(t=>t.profiles.size).length,
    paidEligibleArtists:new Set(requests.filter(r=>r.role==='candidate').map(r=>r.profileId)).size,
    maxConservativeReservationCents:requests.length*2};
  await fs.mkdir(outputDir,{recursive:false});
  await fs.writeFile(path.join(outputDir,'scope.json'),JSON.stringify(scope),{flag:'wx'});
  await fs.writeFile(path.join(outputDir,'source-rows.json'),JSON.stringify(rows),{flag:'wx'});
  await fs.writeFile(path.join(outputDir,'receipt.json'),JSON.stringify({scopeSha256:sha(JSON.stringify(scope)),
    sourceRowsSha256:sha(JSON.stringify(rows)),paidCalls:0}),{flag:'wx'});
  return {outputDir,scopeSha256:sha(JSON.stringify(scope)),artistRecords:targets.length,
    withSavedCandidates:scope.distinctCandidateArtists,paidEligibleArtists:scope.paidEligibleArtists,
    requests:requests.length,controlAccounts:controls.length,controlSourceArtists:scope.controlSourceArtists,
    heldRows:rows.filter(r=>r.status!=='prepared').length,maxReservationUsd:requests.length*0.02,paidCalls:0};
}
