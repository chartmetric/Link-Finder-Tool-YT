import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {compareLikelyReviews} from './instagram-likely-review-audit.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
test('comparison retains every artist, unknown absence, original answers, and controls without network or live writes',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'likely-review-')),batch=path.join(dir,'batch'),out=path.join(dir,'review');
  const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No network in saved comparison.');};
  try{
    await fs.mkdir(batch);await fs.mkdir(path.join(batch,'execution-paid'));await fs.mkdir(path.join(batch,'execution-paid/responses'));
    const music='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
    const artists=['1','2','3'].map(id=>({profile_id:id,artist:'Artist '+id,account_ids:[id],
      accounts:[{account_id:id,platform:'spotify',account_url:music}]}));
    const source=[],requests=[],results=[];
    for(const [key,id,role,verdict] of [['first','1','candidate','likely'],['second','2','candidate','uncertain'],['control','1','control','mismatch']]){
      const player=artists.find(a=>a.profile_id===id),url=`https://www.instagram.com/${key}/`;
      const profile={url,identityComparison:{reference:{url:music},candidate:{url,displayName:'A Different Name',bio:'Label owner'}},
        jevVerification:{verdict:'mismatch',sameIdentityProbability:0.01}};
      const body={state:{artist:player.artist,candidates:[{url}],artistContext:{note:'Saved contextual facts only'}}};
      const sha=hash(JSON.stringify(body));
      requests.push({key,profileId:id,role,body,sha256:sha});
      source.push({key,profileId:id,role,url,artist:player.artist,player,profile,status:'prepared',
        context:{ownershipConfirmed:false,items:[{kind:'release',source:'saved_catalog',text:'A Release'}]}});
      results.push({key,profileId:id,role,instagramUrl:url,score:0.4,verdict,model:'fixture-model',researchPolicySupport:false,reason:'previous_hold'});
      await fs.writeFile(path.join(batch,'execution-paid/responses',key+'.json'),JSON.stringify({status:200,
        decisionRequest:body,requestBodySha256:sha,data:{model:'fixture-model',
          answers:{candidate_0_same_identity:{noul:0.4},candidate_0_verdict:{choice:verdict}}}}));
    }
    source.push({profileId:'3',role:'candidate',artist:'Artist 3',status:'no_saved_candidate',reason:'No saved candidate'});
    const scope={artists,requests,expectedModel:'fixture-model'};
    for(const [file,v] of [['scope.json',scope],['source-rows.json',source],['receipt.json',{
      scopeSha256:hash(JSON.stringify(scope)),sourceRowsSha256:hash(JSON.stringify(source))}],
      ['execution-paid/artist-outcomes.json',artists.map(a=>({profileId:a.profile_id,status:'no_supported_match',supportedUrls:[]}))]])
      await fs.writeFile(path.join(batch,file),JSON.stringify(v));
    const archived=results.map(JSON.stringify).join('\n')+'\n';
    await fs.writeFile(path.join(batch,'execution-paid/results.jsonl'),archived);
    const summary=await compareLikelyReviews(batch,out);
    assert.equal(summary.artistRecords,3);assert.equal(summary.proposedReviewArtists,1);
    assert.equal(summary.artistOutcomes.incomplete_saved_evidence,1);assert.equal(summary.artistOutcomes.model_uncertain,1);
    assert.equal(summary.controls,1);assert.equal(summary.suggestedControls,0);
    assert.equal(summary.newPaidCalls,0);assert.equal(summary.liveLinkChanges,0);assert.equal(summary.productionApproved,false);
    assert.equal(await fs.readFile(path.join(batch,'execution-paid/results.jsonl'),'utf8'),archived);
    const csv=await fs.readFile(path.join(out,'all-500-artists.csv'),'utf8');
    assert.ok(csv.includes('Artist 3'));assert.ok(csv.includes('incomplete_saved_evidence'));
    await assert.rejects(compareLikelyReviews(batch,out),{code:'EEXIST'});
    const file=path.join(batch,'execution-paid/responses/first.json'),packet=JSON.parse(await fs.readFile(file));
    packet.data.answers.candidate_0_same_identity.noul=0.9;await fs.writeFile(file,JSON.stringify(packet));
    await assert.rejects(compareLikelyReviews(batch,path.join(dir,'tampered')),/0.9|0.4/);
  }finally{globalThis.fetch=oldFetch;await fs.rm(dir,{recursive:true,force:true});}
});
