import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {evidenceDigest} from './youtube-ownership-policy.mjs';
import {youtubeCampaignSchema} from './youtube-campaign-core.mjs';
import {instagramProfileUrl} from './musician-instagram-matching.mjs';
import {capturedInstagramTransport} from './instagram-next-saved-batch.mjs';

export const PRIORITY_ID='full-tiers-1-5-no-ig-usd100';
export const prioritySchema=youtubeCampaignSchema
  .replaceAll('youtube_link_campaigns','instagram_priority_runs')
  .replaceAll('youtube_link_campaign_artists','instagram_priority_artists')
  .replaceAll('youtube_link_campaign_admissions','instagram_priority_admissions')
  .replaceAll('youtube_link_campaign_channels','instagram_priority_handles')
  .replaceAll('youtube_link_campaign_next','instagram_priority_next');
export const priorityOrder=(queue)=>queue.map((a,i)=>({...a,originalOrdinal:i})).sort((a,b)=>
  Number(a.tier)-Number(b.tier)||Number(a.tier_rank??Number.MAX_SAFE_INTEGER)-Number(b.tier_rank??Number.MAX_SAFE_INTEGER)
    ||a.originalOrdinal-b.originalOrdinal);
export function legacyCounts(a){
  const c=a.candidates?.[0],checked=Boolean(c?.recordedAnswer);
  return {processed:checked||['unavailable','unsupported'].includes(c?.status)
    ||c?.reason==='interrupted_or_uncertain_no_retry',checked,
    likely:checked&&c?.review?.reviewSuggestion===true};
}
export function validatePriorityAdmission(p,a,pending,{owner,scopeHash,approvalHash,profileId,lowerTier}){
  assert.ok(p&&a);assert.equal(p.owner,owner);assert.equal(p.status,'running');
  assert.equal(p.scope_sha256,scopeHash);assert.equal(p.approval_sha256,approvalHash);
  assert.equal(p.maximum_spend_cents,null);assert.equal(a.profile_id,profileId);
  assert.equal(a.status,'in_progress');assert.equal(Number(pending),0,'Uncertain request cannot be replayed.');
  assert.equal(Number(lowerTier),0,'A higher-priority tier is still pending.');
}
export function validatePriorityRequest(kind,request){
  const u=new URL(request.url);
  if(kind==='search'){
    assert.equal(u.href,'https://google.serper.dev/search');assert.equal(request.method,'POST');
    assert.equal(request.body.num,10);assert.equal(typeof request.body.q,'string');
  }else if(kind==='metadata'){
    assert.equal(u.origin,'https://api.scrapecreators.com');assert.equal(u.pathname,'/v1/instagram/profile');
    assert.equal(request.method,'GET');assert.equal(u.searchParams.size,1);
    assert.ok(instagramProfileUrl('https://www.instagram.com/'+u.searchParams.get('handle')+'/'));
  }else{
    assert.equal(kind,'model');assert.equal(request.method,'POST');
    assert.equal(u.href,'https://openrouter.ai/api/alpha/decisions');
    assert.equal(request.body.model,'typesafe/jev-1.13');
    assert.ok(Buffer.byteLength(JSON.stringify(request.body))<=6000);
  }
}
export function priorityTransport({root,admit,returned,assertFrozen,credentials,fetchImpl=fetch,timeoutMs=120000}){
  return async(profileId,kind,key,request)=>{
    validatePriorityRequest(kind,request);await assertFrozen();
    const op={profileId,kind,key,inputSha256:evidenceDigest(request)};
    await admit(op);
    await fs.appendFile(root+'/admissions.jsonl',JSON.stringify({...op,at:new Date().toISOString(),reservedCents:2})+'\n');
    const controller=new AbortController();let timer;
    try{
      const packet=await Promise.race([(async()=>{
        const r=await fetchImpl(request.url,{method:request.method,signal:controller.signal,redirect:'error',
          headers:kind==='search'?{'X-API-KEY':credentials.serper,'Content-Type':'application/json'}:
            kind==='metadata'?{'x-api-key':credentials.scrapecreators}:
              {Authorization:'Bearer '+credentials.openrouter,'Content-Type':'application/json'},
          ...(request.body?{body:JSON.stringify(request.body)}:{})});
        const chunks=[];let bytes=0;
        if(r.body)for await(const chunk of r.body){bytes+=chunk.length;assert.ok(bytes<=2000000);chunks.push(chunk);}
        const text=Buffer.concat(chunks).toString('utf8');let data,parseFailed=false;
        try{data=JSON.parse(text);}catch{data={};parseFailed=true;}
        return {at:new Date().toISOString(),status:r.status,kind,operationKey:key,inputSha256:op.inputSha256,
          request,data,parseFailed,...(parseFailed?{rawText:text}:{})};
      })(),new Promise((_,reject)=>{timer=setTimeout(()=>{
        controller.abort();reject(Error('provider_timeout_uncertain_no_retry'));
      },timeoutMs);})]);
      await fs.writeFile(root+'/receipts/'+evidenceDigest(key)+'.json',JSON.stringify(packet),{flag:'wx'});
      await returned(op,evidenceDigest(packet),packet.status);
      if(packet.parseFailed)throw Error('provider_unreadable_response');
      const message=JSON.stringify({error:packet.data?.error,message:packet.data?.message,errorStatus:packet.data?.errorStatus});
      if([401,402,429].includes(packet.status)||/insufficient.{0,30}(?:credit|balance)|(?:not enough|out of).{0,20}credits?|credits?.{0,30}(?:exhaust|deplet)|invalid.{0,12}api.?key/i.test(message))
        throw Error('provider_funding_authentication_or_rate_limit');
      if(packet.status===403&&!(kind==='metadata'&&packet.data?.success===true&&packet.data?.age_restricted===true))
        throw Error('provider_access_failure');
      if(packet.status>=300&&packet.status<400)throw Error('provider_unexpected_redirect');
      return packet;
    }finally{clearTimeout(timer);}
  };
}
// Interpret an already saved exact response through the existing Instagram
// normalization/access policy. The injected fetch cannot access the network.
export async function normalizeSavedInstagram(packet,url,directory,key){
  assert.equal(packet.kind,'metadata');
  const endpoint=new URL(packet.request.url);
  assert.equal(endpoint.searchParams.get('handle'),new URL(url).pathname.split('/')[1]);
  const transport=capturedInstagramTransport({apiKey:'saved-response-only',responseDir:directory,
    continueAcknowledgedServerErrors:true,fetchImpl:async requested=>{
      assert.equal(String(requested),packet.request.url);
      return new Response(JSON.stringify(packet.data),{status:packet.status});
    }});
  const body={url};
  const {digest}=await import('./instagram-next-saved-batch.mjs');
  return transport.dispatch({kind:'scrapecreators_candidate',key,payload:{body,inputSha256:digest(body)}});
}
