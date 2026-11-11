import assert from 'node:assert/strict';
import {select,metadataQueries,buildMetadataOverlay} from './instagram-artist-metadata-overlay.mjs';
import {youtubeEligibilitySql,youtubeSearchCandidates} from './youtube-discovery-test.mjs';
import {instagramProfileUrl} from './musician-instagram-matching.mjs';
import {instagramSearchCandidates} from './instagram-search-clues.mjs';
import {serperQuery} from './instagram-pilot-live-transport.mjs';
import {enrichedRequest} from './instagram-next-saved-batch.mjs';
import {answersFrom} from './instagram-jev-label-ablation.mjs';
import {catalogBoundReviewSuggestion} from './instagram-likely-review-policy.mjs';
import {normalizeSavedInstagram} from './instagram-tier-priority-core.mjs';
import {evaluateCandidate,classifyYoutubeResult} from './youtube-campaign-core.mjs';
import {evidenceDigest as hash} from './youtube-ownership-policy.mjs';
import {readJson,saveJson} from './campaign-parallel-core.mjs';

export function eligibilitySql(platform,ids){
  assert.ok(['instagram','youtube'].includes(platform)&&ids.length&&ids.every(x=>/^\d+$/.test(x)));
  return youtubeEligibilitySql.replaceAll("'youtube'",`'${platform}'`).replace(' LIMIT 4 BY t.tier','')
    .replace('ORDER BY t.tier,t.tier_rank,p.id',`AND p.id IN (${ids.join(',')}) ORDER BY t.tier,t.tier_rank,p.id`);
}
export async function catalogContexts(platform,root,targets){
  const cached=new Map(),missing=[];
  for(const a of targets){
    try{
      const p=await readJson(root+'/metadata/'+a.profile_id+'.json');
      assert.equal(p.profileId,a.profile_id);assert.equal(p.cmArtist,a.cm_artist);cached.set(p.profileId,p);
    }catch(e){if(e.code!=='ENOENT')throw e;missing.push(a);}
  }
  if(missing.length){
    const manifest={artists:missing.map(a=>({...a,accounts:[],account_ids:[]}))};
    const query=q=>platform==='youtube'?q.replaceAll("platform!='instagram'","platform!='youtube'"):q;
    const accounts=await select(query(metadataQueries(manifest).accounts));
    for(const a of manifest.artists){
      a.accounts=accounts.filter(x=>x.profile_id===a.profile_id&&x.account_url?.trim()
        &&(x.platform!=='spotify'||/^https:\/\/open\.spotify\.com\/artist\/[A-Za-z0-9]{22}\/?(?:\?.*)?$/.test(x.account_url)));
      a.account_ids=a.accounts.map(x=>x.account_id);
    }
    const data={accounts},queries=metadataQueries(manifest);
    // Independent catalog reads in bounded groups, not paid provider requests.
    const keys=Object.keys(queries).filter(k=>k!=='accounts');
    for(let i=0;i<keys.length;i+=3)await Promise.all(keys.slice(i,i+3).map(async k=>{data[k]=await select(query(queries[k]));}));
    for(const p of buildMetadataOverlay(manifest,data,new Date().toISOString()).packets){
      await saveJson(root+'/metadata/'+p.profileId+'.json',p);cached.set(p.profileId,p);
    }
  }
  return new Map(targets.map(a=>{
    const p=cached.get(a.profile_id);assert.ok(p);assert.equal(p.cmArtist,a.cm_artist);
    if(platform==='youtube')return [a.profile_id,{profileId:p.profileId,cmArtist:p.cmArtist,name:p.artist,catalogProfile:p.catalogProfile,
      country:p.chartmetric?.code2??null,label:p.chartmetric?.label??p.chartmetric?.record_label??null,
      accounts:p.linkedAccounts.filter(x=>x.account_url?.trim()),releases:[...p.releases,...p.catalogTracks],
      context:{chartmetric:p.chartmetric,tags:p.tags,spotify:p.spotifyMetadata,platformSnapshots:p.platformSnapshots,
        profileMetadata:p.profileMetadata,
        warning:'Catalog context is not independent ownership proof. Platform snapshots are not account-bound captures.'}}];
    const accounts=p.linkedAccounts.filter(x=>x.account_url?.trim());
    return [a.profile_id,{profileId:p.profileId,artist:p.artist,
      player:{profile_id:p.profileId,cm_artist:p.cmArtist,artist:p.artist,accounts,account_ids:accounts.map(x=>x.account_id),
        source_identity_matches:true,catalog_profile:p.catalogProfile},
      context:{ownershipConfirmed:false,items:p.chartmetric?.code2?[{kind:'country',source:'new_vertical.cm_artist',
        text:p.chartmetric.code2,binding:'catalog_artist_identity_only',asOf:p.catalogProfile.source_updated_at,stale:false}]:[]},
      sourceCapturedAt:p.collectedAt,sourceArtistName:p.artist,candidates:[]}];
  }));
}
export async function instagramSavedCandidates(targets){
  const saved=new Map();
  if(!targets.length)return saved;
  const rows=await select(`SELECT toString(profile_id) profile_id,argMax(tuple(cm_artist,artist,result_json),updated_at) latest,
    toString(max(updated_at),'UTC') captured_at FROM poc_new_verticals.musician_instagram_discovery_events
    WHERE profile_id IN (${targets.map(a=>a.profile_id).join(',')}) AND status='candidates_found' GROUP BY profile_id`);
  for(const row of rows)saved.set(row.profile_id,row);
  return saved;
}
export async function processInstagram({target,a,source,root,request,conflict}){
  const active=a.profile_id;
  if(source&&String(source.latest[0])===a.cm_artist){
    const parsed=JSON.parse(source.latest[2]);assert.ok(Array.isArray(parsed.profiles));
    target.candidates=parsed.profiles.flatMap(c=>{const url=instagramProfileUrl(c.url);return url?[{...c,url}]:[];});
    target.sourceCapturedAt=source.captured_at;target.sourceArtistName=source.latest[1];
  }
  if(!target.candidates.length)for(const queryIndex of [0,1]){
    const packet=await request(active,'search','search-'+active+'-'+queryIndex,{
      method:'POST',url:'https://google.serper.dev/search',body:{q:serperQuery({artist:a.artist,queryIndex}),num:10}});
    if(packet.status>=500){target.searchUnavailable=true;break;}
    assert.equal(packet.status,200);assert.ok(Array.isArray(packet.data.organic),'Search failure is not absence.');
    target.candidates=instagramSearchCandidates(packet.data.organic.map(h=>({...h,observedAt:packet.at})),
      a.artist,{explicitAliases:true});
    target.sourceCapturedAt=packet.at;if(target.candidates.length)break;
  }
  const expanded=instagramSearchCandidates([],a.artist,{explicitAliases:true,savedCandidates:target.candidates});
  // A resumed older campaign uses its sealed parser, which ignores the new
  // options and returns []; keep that campaign's original candidate ordering.
  if(expanded.length)target.candidates=expanded;
  target.candidates=[...new Map(target.candidates.map(c=>[c.url,c])).values()];
  await saveJson(root+'/inputs/'+active+'-scope.json',target);
  const findings=[];
  for(const candidate of target.candidates){
    const key=active+'-'+hash(candidate.url);
    const shared=await conflict(candidate.url,active);
    const packet=await request(active,'metadata','metadata-'+key,{method:'GET',
      url:'https://api.scrapecreators.com/v1/instagram/profile?'+new URLSearchParams({handle:new URL(candidate.url).pathname.split('/')[1]})});
    const metadata=await normalizeSavedInstagram(packet,candidate.url,root+'/normalized',key);
    const finding={...candidate,metadata,reviewSuggestion:false,status:'metadata_unavailable',reason:metadata.reason??null};
    findings.push(finding);
    if(!metadata.available){if(packet.status>=500)break;continue;}
    let built;
    try{built=enrichedRequest({...target,selected:candidate},metadata.candidate);}
    catch{finding.status='held';finding.reason='complete_evidence_does_not_fit_supported_request';continue;}
    await saveJson(root+'/inputs/'+key+'.json',{request:built.body,requestSha256:built.sha256});
    const response=await request(active,'model','model-'+key,{method:'POST',url:'https://openrouter.ai/api/alpha/decisions',body:built.body});
    if(response.status>=500){finding.status='model_unavailable';finding.reason='acknowledged_provider_server_error_not_retried';break;}
    assert.equal(response.status,200);assert.ok(!response.data.error);
    assert.ok(['typesafe/jev-1.13','typesafe/jev-1.13-20260917'].includes(response.data.model));
    assert.ok(Number.isFinite(response.data.usage?.cost)&&response.data.usage.cost>=0&&response.data.usage.cost<=.02);
    const answer=answersFrom(response.data,1)[0];assert.ok(answer);
    const decision=catalogBoundReviewSuggestion({...built.profile,jevVerification:answer},target.player,
      {sharedHandle:shared||await conflict(candidate.url,active),
        guardPolicy:'targeted_title_guard',modelState:built.body.state});
    Object.assign(finding,{status:decision.status,reason:decision.reason,reviewSuggestion:decision.reviewSuggestion,
      decision,recordedAnswer:answer,metadataActuallyUsed:built.body.state,requestSha256:built.sha256});
    if(finding.reviewSuggestion)break;
  }
  const checked=findings.some(f=>f.recordedAnswer),likely=findings.some(f=>f.reviewSuggestion);
  const result={profileId:active,cmArtist:a.cm_artist,artist:a.artist,tier:a.tier,
    outcome:likely?'likely_review_suggestion':target.searchUnavailable?'search_unavailable':
      target.candidates.length?'checked_no_accepted_candidate':'completed_no_candidate_result',
    checked,likelyReviewSuggestion:likely,candidates:findings,allCandidates:target.candidates,
    artistCatalogMetadata:target.player,verified:false,liveLinkChanged:false};
  return {result,stats:{searched:true,checked,likely,candidates:target.candidates.length},reason:result.outcome};
}
export async function processYoutube({target:artist,a,root,request,conflict}){
  const packet=await request(a.profile_id,'search','search-'+a.profile_id,{method:'POST',
    url:'https://google.serper.dev/search',body:{q:`${artist.name} artist official YouTube channel`,num:10}});
  assert.equal(packet.status,200,'Search failure is not absence.');
  const found=youtubeSearchCandidates(packet.data),result={artist,searchStatus:found.length?'candidates_found':'no_match',candidates:[]};
  for(const candidate of found){
    const checked=await evaluateCandidate({artist,candidate,request,channelConflict:conflict});
    result.candidates.push(checked);
    await saveJson(root+'/inputs/'+a.profile_id+'-'+hash(candidate.url)+'.json',checked);
  }
  return {result,stats:classifyYoutubeResult(result),reason:null};
}
