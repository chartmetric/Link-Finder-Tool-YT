// Continuous YouTube work has its own approval and coordinator. It never
// modifies the running Instagram worker, its ledger, or any catalog link.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {evidenceDigest,youtubeOwnershipUrl,youtubeVerificationInput,evaluateYoutubeOwnership} from './youtube-ownership-policy.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest,parseYoutubeDecision,providerStopReason} from './youtube-ownership-transport.mjs';

export const YOUTUBE_CAMPAIGN_ID='full-tiers-1-5-no-youtube-uncapped';
export const YOUTUBE_CAMPAIGN_ROOT='generated-artifacts/'+YOUTUBE_CAMPAIGN_ID;
export const MODEL_PLAN={model:{endpoint:'https://openrouter.ai/api/alpha/decisions',
  expectedModel:'typesafe/jev-1.13',maxRequestBytes:64000}};
export const youtubeCampaignSchema=`
CREATE TABLE IF NOT EXISTS youtube_link_campaigns (
 id text PRIMARY KEY,owner uuid NOT NULL,scope_sha256 text NOT NULL,approval_sha256 text NOT NULL,
 maximum_spend_cents bigint CHECK(maximum_spend_cents IS NULL),
 reserved_cents bigint NOT NULL DEFAULT 0 CHECK(reserved_cents>=0),
 total_artists integer NOT NULL CHECK(total_artists>0),
 status text NOT NULL CHECK(status IN ('prepared','running','completed','stopped')),
 stop_reason text,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS youtube_link_campaign_artists (
 campaign_id text NOT NULL REFERENCES youtube_link_campaigns(id),
 profile_id text NOT NULL,cm_artist text NOT NULL,artist text NOT NULL,
 tier integer NOT NULL CHECK(tier BETWEEN 1 AND 5),ordinal integer NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','in_progress','completed','deferred','failed')),
 searched boolean NOT NULL DEFAULT false,checked boolean NOT NULL DEFAULT false,
 likely boolean NOT NULL DEFAULT false,candidates integer NOT NULL DEFAULT 0,
 result_sha256 text,reason text,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(campaign_id,profile_id),UNIQUE(campaign_id,ordinal)
);
CREATE TABLE IF NOT EXISTS youtube_link_campaign_admissions (
 campaign_id text NOT NULL REFERENCES youtube_link_campaigns(id),operation_key text NOT NULL,
 profile_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('search','metadata','model')),
 input_sha256 text NOT NULL,reserved_cents integer NOT NULL CHECK(reserved_cents=2),
 status text NOT NULL DEFAULT 'admitted' CHECK(status IN ('admitted','returned')),
 receipt_sha256 text,http_status integer,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(campaign_id,operation_key)
);
CREATE TABLE IF NOT EXISTS youtube_link_campaign_channels (
 campaign_id text NOT NULL REFERENCES youtube_link_campaigns(id),channel_id text NOT NULL,
 profile_id text NOT NULL,PRIMARY KEY(campaign_id,channel_id,profile_id)
);
CREATE INDEX IF NOT EXISTS youtube_link_campaign_next ON youtube_link_campaign_artists(campaign_id,ordinal) WHERE status='queued';`;

export function validateQueue(queue){
  assert.ok(Array.isArray(queue)&&queue.length>0);
  const profiles=new Set();
  let priorTier=0;
  for(const a of queue){
    assert.match(a.profile_id,/^\d+$/);assert.match(a.cm_artist,/^\d+$/);
    assert.ok(typeof a.artist==='string'&&a.artist.trim());
    assert.ok(Number.isInteger(a.tier)&&a.tier>=1&&a.tier<=5&&a.tier>=priorTier);
    assert.ok(!profiles.has(a.profile_id),'Duplicate profile in frozen queue.');
    profiles.add(a.profile_id);priorTier=a.tier;
  }
  return queue;
}
export function assertAdmission(campaign,artist,pending,{owner,scopeHash,approvalHash,profileId}){
  assert.ok(campaign&&artist);
  assert.equal(campaign.owner,owner);assert.equal(campaign.status,'running');
  assert.equal(campaign.maximum_spend_cents,null);
  assert.equal(campaign.scope_sha256,scopeHash);assert.equal(campaign.approval_sha256,approvalHash);
  assert.equal(artist.profile_id,profileId);assert.equal(artist.status,'in_progress');
  assert.equal(Number(pending),0,'Uncertain request blocks all further spending.');
}
export function classifyYoutubeResult(record){
  const decisions=record.candidates.map(c=>c.decision);
  return {searched:record.searchStatus==='candidates_found'||record.searchStatus==='no_match',
    checked:decisions.some(d=>['likely_artist_owned','supported_topic','related_catalog_channel','not_artist_owned','ownership_conflict'].includes(d.status)
      ||(d.status==='needs_identity_check'&&d.reason==='recorded_model_uncertain_or_unresolved_channel_type'&&Number.isFinite(d.score))),
    likely:decisions.some(d=>d.reviewSuggestion===true),candidates:decisions.length};
}
export function validateRequest(kind,request){
  if(kind==='search'){
    assert.equal(request.method,'POST');assert.equal(request.url,'https://google.serper.dev/search');
    assert.equal(request.body.num,10);assert.equal(typeof request.body.q,'string');
  }else if(kind==='metadata'){
    const u=new URL(request.url);
    assert.equal(u.origin,'https://api.scrapecreators.com');assert.equal(u.pathname,'/v1/youtube/channel');
    assert.equal(u.searchParams.size,1);assert.ok(youtubeOwnershipUrl(u.searchParams.get('url')));
    assert.equal(request.method,'GET');assert.equal(request.body,undefined);
  }else{
    assert.equal(kind,'model');assert.equal(request.method,'POST');
    assert.equal(request.url,MODEL_PLAN.model.endpoint);
    assert.equal(request.body.model,MODEL_PLAN.model.expectedModel);
    assert.ok(Buffer.byteLength(JSON.stringify(request.body))<=MODEL_PLAN.model.maxRequestBytes);
  }
}
export function campaignTransport({admit,returned,root,assertFrozen,fetchImpl=fetch,credentials,timeoutMs=120000}){
  return async(profileId,kind,key,request)=>{
    validateRequest(kind,request);await assertFrozen();
    const inputSha256=evidenceDigest(request),op={profileId,kind,key,inputSha256};
    // A committed admission protects the request even if writing the local
    // journal, dispatching, saving a receipt, or returning it subsequently fails.
    await admit(op);
    await fs.appendFile(root+'/admissions.jsonl',JSON.stringify({...op,at:new Date().toISOString(),reservedCents:2})+'\n');
    const headers=kind==='search'?{'X-API-KEY':credentials.serper,'Content-Type':'application/json'}:
      kind==='metadata'?{'x-api-key':credentials.scrapecreators}:
        {Authorization:'Bearer '+credentials.openrouter,'Content-Type':'application/json'};
    const controller=new AbortController();
    let timer;
    try{
      const packet=await Promise.race([(async()=>{
        const response=await fetchImpl(request.url,{method:request.method,headers,
          signal:controller.signal,redirect:'error',...(request.body?{body:JSON.stringify(request.body)}:{})});
        const chunks=[];let bytes=0;
        if(response.body)for await(const chunk of response.body){
          bytes+=chunk.length;assert.ok(bytes<=2000000,'Response too large; do not replay this request.');chunks.push(chunk);
        }
        let data=null,parseFailed=false;const text=Buffer.concat(chunks).toString('utf8');
        try{data=JSON.parse(text);}catch{parseFailed=true;}
        return {at:new Date().toISOString(),kind,operationKey:key,status:response.status,
          inputSha256,request,data,parseFailed,...(parseFailed?{rawText:text}:{})};
      })(),new Promise((_,reject)=>{timer=setTimeout(()=>{
        controller.abort();reject(Error('provider_timeout_uncertain_no_retry'));
      },timeoutMs);})]);
      await fs.writeFile(root+'/receipts/'+evidenceDigest(key)+'.json',JSON.stringify(packet),{flag:'wx'});
      await returned(op,evidenceDigest(packet),packet.status);
      const reason=providerStopReason(packet);
      if(reason)throw Error(reason);
      if(packet.status>=500)throw Error('provider_server_error_no_retry');
      return packet;
    }finally{clearTimeout(timer);}
  };
}
export async function evaluateCandidate({artist,candidate,request,channelConflict,channelCache=null}){
  const url=youtubeOwnershipUrl(candidate.url);
  if(channelCache?.reuse(artist,candidate))return candidate;
  const packet=await request(artist.profileId,'metadata','channel-'+artist.profileId+'-'+evidenceDigest(url),{
    method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?'+new URLSearchParams({url})});
  candidate.capture=normalizeYoutubeChannel(packet,url);
  if(channelCache?.observe(artist,candidate))return candidate;
  let conflict=false;
  if(candidate.capture)conflict=await channelConflict(candidate.capture.body.channelId,artist.profileId);
  let decision=evaluateYoutubeOwnership(artist,candidate,{sharedChannel:conflict,
    contradictoryPair:candidate.contradictoryPair===true});
  if(decision.status==='needs_identity_check'){
    const input=youtubeVerificationInput(artist,candidate),prepared=youtubeDecisionRequest(input,MODEL_PLAN);
    candidate.metadataActuallyUsed=input;
    if(!prepared.ready){
      candidate.modelIssue='model_request_exceeds_approved_byte_limit';
      decision={...decision,reason:candidate.modelIssue};
    }else{
      const response=await request(artist.profileId,'model','model-'+artist.profileId+'-'+evidenceDigest(url),prepared.request);
      candidate.recordedAnswer=parseYoutubeDecision(response,input,MODEL_PLAN,prepared.inputSha256);
      decision=evaluateYoutubeOwnership(artist,candidate,{sharedChannel:conflict,answer:candidate.recordedAnswer});
    }
  }
  candidate.decision=decision;
  return candidate;
}
