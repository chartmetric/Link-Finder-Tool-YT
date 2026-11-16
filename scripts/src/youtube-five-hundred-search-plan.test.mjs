import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {stagedSearchPlan} from './youtube-staged-search-plan.mjs';
import {hundredSearchPlan,approveHundredSearch} from './youtube-hundred-search-plan.mjs';
import {fiveHundredSearchPlan,approveFiveHundredSearch} from './youtube-five-hundred-search-plan.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
function fixture(){
  const at='2026-11-16T18:00:00Z';
  const children=Array.from({length:5},(_,group)=>{
    const cohorts=Array.from({length:5},(_,part)=>{
      const artists=Array.from({length:20},(_,n)=>{
        const ordinal=group*100+part*20+n+1;
        return {profile_id:String(ordinal),cm_artist:String(ordinal+1000),
          artist:'Artist '+ordinal,tier:2,ordinal,snapshot_at:'2026-11-16 01:30:16'};
      });
      const id=`youtube-test-five-hundred-group-${group}-part-${part}`;
      const packets=artists.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,
        catalogProfile:{profile_id:a.profile_id,cm_artist:a.cm_artist},
        linkedAccounts:[],releases:[],catalogTracks:[]}));
      return {id,plan:stagedSearchPlan({id,preparedAt:at,artists,packets,
        evidenceFiles:{'evidence/catalog.json':digest('evidence')},
        runtimeFiles:{'runtime/leaf.mjs':digest('leaf')}})};
    });
    const id='youtube-batch-100-five-hundred-group-'+group;
    return {id,plan:hundredSearchPlan({id,preparedAt:at,children:cohorts,
      runtimeFiles:{'runtime/child.mjs':digest('child')}})};
  });
  return fiveHundredSearchPlan({id:'youtube-batch-500-fixture',preparedAt:at,children,
    runtimeFiles:{'runtime/parent.mjs':digest('parent')}});
}
test('500-search aggregate preserves all 25 strict twenty-artist caps and requires exact separate approval',()=>{
  const p=fixture();
  assert.equal(p.totalArtists,500);assert.equal(p.maximumSpendCents,1000);
  assert.deepEqual(p.allowedKinds,['search']);assert.equal(p.explicitApproval,false);
  assert.equal(p.unknownDownstreamRequestsApproved,false);
  assert.ok(p.children.every(c=>c.capCents===200&&c.plan.children.every(s=>s.capCents===40)));
  const a=approveFiveHundredSearch(p,{planSha256:digest(p),capCents:1000,approvedAt:p.preparedAt});
  assert.equal(a.explicitApproval,true);
  assert.throws(()=>approveHundredSearch(p.children[0].plan,{...a,planSha256:digest(p.children[0].plan)}));
  for(const change of [
    x=>x.children[1]=structuredClone(x.children[0]),
    x=>x.children[0].plan.children[0].plan.operations[0].kind='metadata',
    x=>x.maximumSpendCents=2000,
    x=>x.runtimeFiles['runtime/parent.mjs']=digest('changed'),
    x=>x.allowedKinds.push('model'),
    x=>x.explicitApproval=true,
  ]){
    const changed=structuredClone(p);change(changed);
    assert.throws(()=>approveFiveHundredSearch(changed,a));
  }
  assert.throws(()=>approveFiveHundredSearch(p,{...a,capCents:200}));
});
test('fresh five-hundred validator independently rejects profile and artist reuse across bundles',()=>{
  const p=fixture();
  for(const key of ['profile_id','cm_artist']){
    // Reusing an otherwise valid complete child passes each legacy validator
    // but must never pass the outer uniqueness checks.
    const next=structuredClone(p);
    next.children[1].plan=structuredClone(next.children[0].plan);
    next.children[1].plan.id='youtube-batch-100-other-valid-id';
    next.children[1].id=next.children[1].plan.id;
    assert.throws(()=>fiveHundredSearchPlan(next),key);
  }
});
test('sealed parent verifies nested runtimes and evidence without authorizing or making requests',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-500-'));
  const old=process.cwd();
  try{
    const root=path.join(temp,'generated-artifacts/youtube-batch-500-fixture');
    await fs.mkdir(root,{recursive:true});
    const files=await freezeLocalModules(path.resolve('scripts/src/run-youtube-five-hundred-search.mjs'),root+'/runtime');
    const p=fixture();p.runtimeFiles={};
    for(const file of files)p.runtimeFiles['runtime/'+path.basename(file)]=digest(await fs.readFile(file));
    for(const child of p.children){
      child.planSha256=digest(child.plan);
      for(const part of [child,...child.plan.children]){
        const folder=path.join(temp,'generated-artifacts',part.id);await fs.mkdir(folder,{recursive:true});
        const plan=part.plan;
        for(const [name] of Object.entries({...plan.evidenceFiles,...plan.runtimeFiles})){
          await fs.mkdir(path.dirname(folder+'/'+name),{recursive:true});
          await fs.writeFile(folder+'/'+name,name.includes('evidence')?'evidence':part===child?'child':'leaf');
        }
        await fs.writeFile(folder+'/plan.json',JSON.stringify(plan));
      }
    }
    await fs.writeFile(root+'/plan.json',JSON.stringify(p));
    const {assertFiveHundredFrozen}=await import(pathToFileURL(root+'/runtime/run-youtube-five-hundred-search.mjs'));
    process.chdir(temp);await assertFiveHundredFrozen(root,p);
    const leaf=p.children[0].plan.children[0];
    await fs.writeFile('generated-artifacts/'+leaf.id+'/runtime/leaf.mjs','tampered');
    await assert.rejects(assertFiveHundredFrozen(root,p));
    assert.ok(!(await fs.readdir(root)).includes('approval.json'));
  }finally{process.chdir(old);await fs.rm(temp,{recursive:true,force:true});}
});
