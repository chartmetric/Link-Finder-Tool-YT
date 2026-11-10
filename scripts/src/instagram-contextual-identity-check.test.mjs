import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkContextualIdentity} from './instagram-contextual-identity-check.mjs';
import {jevRequest} from './instagram-pilot-live-transport.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const save=(f,v)=>fs.writeFile(f,JSON.stringify(v));
test('whole-batch offline replay binds actual answers, keeps old files, and emits unsent complete-context drafts only',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'identity-check-')),batch=path.join(dir,'batch'),out=path.join(dir,'after');
  const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Offline audit cannot call providers');};
  try{
    await fs.mkdir(batch);await fs.mkdir(path.join(batch,'execution-paid'));await fs.mkdir(path.join(batch,'execution-paid/responses'));
    const url='https://www.instagram.com/example_artist/',music='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
    const player={profile_id:'1',cm_artist:'2',artist:'Example Artist',account_ids:['3'],
      accounts:[{platform:'spotify',account_id:'3',account_url:music}]};
    const p={url,identityComparison:{status:'likely',reference:{platform:'spotify',url:music},
      candidate:{url,displayName:player.artist,bio:'Singer and songwriter. Label owner @our_label',externalUrls:[music],directExternalUrls:[music]}}};
    const body=jevRequest({artist:player.artist,catalogReference:{url:music,platform:'spotify'},profiles:[p]});
    const sha=hash(JSON.stringify(body)),context={ownershipConfirmed:false,items:[
      {kind:'release',source:'frozen_catalog',text:'Silver Horizon — Example Artist',asOf:'2026-01-01'},
    ]};
    const scope={expectedModel:'fixture-model',artists:[player],requests:[{key:'first',profileId:'1',role:'candidate',sha256:sha,body}],inputs:[]};
    const source=[{key:'first',profileId:'1',artist:player.artist,role:'candidate',url,profile:p,player,context,status:'prepared'}];
    await save(path.join(batch,'scope.json'),scope);await save(path.join(batch,'source-rows.json'),source);
    await save(path.join(batch,'receipt.json'),{scopeSha256:hash(JSON.stringify(scope)),sourceRowsSha256:hash(JSON.stringify(source))});
    await save(path.join(batch,'execution-paid/artist-outcomes.json'),[{profileId:'1',artist:player.artist,
      status:'no_supported_match',supportedUrls:[]}]);
    const row={key:'first',model:'fixture-model',role:'candidate',instagramUrl:url,verdict:'likely',score:0.62,
      researchPolicySupport:false,reason:'related_entity_or_fan'};
    await fs.writeFile(path.join(batch,'execution-paid/results.jsonl'),JSON.stringify(row)+'\n');
    const packet={status:200,decisionRequest:body,requestBodySha256:sha,data:{model:'fixture-model',
      answers:{candidate_0_same_identity:{noul:0.62},candidate_0_verdict:{choice:'likely'}}}};
    const responseFile=path.join(batch,'execution-paid/responses/first.json');await save(responseFile,packet);
    const original=await fs.readFile(responseFile,'utf8'),originalRows=await fs.readFile(path.join(batch,'execution-paid/results.jsonl'),'utf8');
    const result=await checkContextualIdentity(batch,out);
    assert.equal(result.originalSupportedArtists,0);assert.equal(result.offlineSupportedArtists,1);
    assert.equal(result.regressedArtists,0);assert.equal(result.newPaidCalls,0);
    assert.equal(result.liveLinkChanges,0);assert.equal(result.productionApproved,false);
    assert.equal(result.completeUnsentDrafts,1);
    const draft=JSON.parse(await fs.readFile(path.join(out,'unsent-drafts/first.json'),'utf8'));
    assert.equal(draft.sent,false);assert.ok(draft.bytes<=6000);assert.equal(draft.sha256,hash(JSON.stringify(draft.body)));
    assert.equal(draft.body.state.artistContext.savedCatalogContext.items[0].text,context.items[0].text);
    assert.equal(await fs.readFile(responseFile,'utf8'),original);
    assert.equal(await fs.readFile(path.join(batch,'execution-paid/results.jsonl'),'utf8'),originalRows);
    await assert.rejects(checkContextualIdentity(batch,out),{code:'EEXIST'});
    packet.data.answers.candidate_0_same_identity.noul=0.9;await save(responseFile,packet);
    await assert.rejects(checkContextualIdentity(batch,path.join(dir,'tampered')),/0.9|0.62/);
  }finally{globalThis.fetch=originalFetch;await fs.rm(dir,{recursive:true,force:true});}
});
