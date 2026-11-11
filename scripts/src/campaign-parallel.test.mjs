import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertParallelAdmission,sameTierBatch,drainBatch,rollingArtists,preparedArtistBuffer,gradualCapacity,pacedAdmissions,safeDiagnostic,verifyArchive} from './campaign-parallel-core.mjs';
import {evidenceDigest as hash} from './youtube-ownership-policy.mjs';
import {priorityTransport} from './instagram-tier-priority-core.mjs';
const fixture=()=>({run:{owner:'owner',status:'running',maximum_spend_cents:null,scope_sha256:'scope',approval_sha256:'approval'},
  artist:{profile_id:'3',status:'in_progress'},owner:'owner',approval:{scopeSha256:'scope'},approvalHash:'approval',
  pending:[],live:new Map(),lowerTier:0,width:3,closed:false});
test('only the earliest pending tier enters a parallel wave',()=>{
  const rows=[{tier:3,ordinal:0},{tier:2,ordinal:10},{tier:2,ordinal:8},{tier:2,ordinal:9},{tier:2,ordinal:11}];
  assert.deepEqual(sameTierBatch(rows).map(a=>a.ordinal),[8,9,10]);
  assert.deepEqual(sameTierBatch([{tier:1,ordinal:12},{tier:2,ordinal:0}]),[{tier:1,ordinal:12}]);
});
test('known live requests for other artists can overlap, abandoned admissions cannot',()=>{
  const f=fixture();
  f.pending=[{operation_key:'op1',profile_id:'1'},{operation_key:'op2',profile_id:'2'}];
  f.live=new Map([['op1','1'],['op2','2']]);assert.doesNotThrow(()=>assertParallelAdmission(f));
  f.live.delete('op1');assert.throws(()=>assertParallelAdmission(f),/Unknown or abandoned/);
});
test('tier, duplicate artist, width, owner, stopped state and closed gate remain fences',()=>{
  for(const change of [{lowerTier:1},{width:129},{closed:true},{owner:'other'},
    {run:{...fixture().run,status:'stopped'}},
    {pending:[{operation_key:'same',profile_id:'3'}],live:new Map([['same','3']])},
    {pending:[1,2,3].map(x=>({operation_key:String(x),profile_id:String(x)}))}]){
    assert.throws(()=>assertParallelAdmission({...fixture(),...change}));
  }
});
test('eight-slot admission still rejects unknown requests and a ninth live request',()=>{
  const f=fixture();f.width=8;
  f.pending=Array.from({length:7},(_,i)=>({operation_key:'op'+i,profile_id:'p'+i}));
  f.live=new Map(f.pending.map(p=>[p.operation_key,p.profile_id]));
  assert.doesNotThrow(()=>assertParallelAdmission(f));
  f.pending.push({operation_key:'eighth',profile_id:'p8'});f.live.set('eighth','p8');
  assert.throws(()=>assertParallelAdmission(f),/Parallel request limit/);
});
test('rolling work refills a finished slot before its slow peer finishes',async()=>{
  const waiting=[1,2,3],events=[];let active=0,peak=0,releaseSlow;
  const slow=new Promise(r=>{releaseSlow=r;});
  await rollingArtists({width:2,load:async n=>waiting.splice(0,n),work:async id=>{
    active++;peak=Math.max(peak,active);events.push('start'+id);
    if(id===1)await slow;
    if(id===3){assert.ok(!events.includes('end1'));releaseSlow();}
    events.push('end'+id);active--;
  },onError:()=>assert.fail('Unexpected failure')});
  assert.equal(peak,2);assert.equal(events.filter(e=>e.startsWith('start')).length,3);
});
test('rolling refills exclude prepared artists while their database claims are delayed',async()=>{
  const states=new Map(Array.from({length:24},(_,i)=>[String(i+1),'queued']));
  const seen=new Set();let active=0,peak=0;
  await rollingArtists({width:8,load:async(n,prepared=[])=>{
    const excluded=new Set(prepared);
    return [...states].filter(([id,state])=>state==='queued'&&!excluded.has(id)).slice(0,n).map(([id])=>id);
  },work:async id=>{
    // A database pool can leave a prepared artist queued after another lane
    // finishes. That artist must remain excluded from subsequent refills.
    await new Promise(r=>setTimeout(r,Number(id)%3===0?12:2));
    assert.equal(states.get(id),'queued');assert.ok(!seen.has(id),'duplicate prepared artist');
    seen.add(id);states.set(id,'in_progress');active++;peak=Math.max(peak,active);
    await new Promise(r=>setTimeout(r,Number(id)%2===0?1:5));
    states.set(id,'completed');active--;
  },onError:()=>{}});
  assert.equal(seen.size,24);assert.ok(peak<=8);
  assert.ok([...states.values()].every(s=>s==='completed'));
});
test('sixteen rolling slots share bounded catalog batches without duplicate or higher-tier dispatch',async()=>{
  const states=new Map(Array.from({length:160},(_,i)=>[String(i),{tier:i<80?1:2,status:'queued'}]));
  const seen=new Set();let prepares=0,active=0,peak=0;
  const next=preparedArtistBuffer({batchSize:64,prepare:async(n,prepared)=>{
    assert.equal(n,64);
    const excluded=new Set(prepared);
    const tier=Math.min(...[...states.values()].filter(a=>a.status!=='completed').map(a=>a.tier));
    const rows=[...states].filter(([id,a])=>a.tier===tier&&a.status==='queued'&&!excluded.has(id))
      .slice(0,n).map(([id])=>id);
    if(rows.length)prepares++;
    return rows;
  }});
  await rollingArtists({width:16,load:next,work:async id=>{
    await new Promise(r=>setTimeout(r,Number(id)%3===0?4:1));
    const artist=states.get(id);assert.equal(artist.status,'queued');assert.ok(!seen.has(id));
    assert.ok([...states.values()].every(a=>a.tier>=artist.tier||a.status==='completed'),'lower tier still pending');
    seen.add(id);artist.status='in_progress';active++;peak=Math.max(peak,active);
    await new Promise(r=>setTimeout(r,Number(id)%2===0?1:3));
    artist.status='completed';active--;
  },onError:()=>{}});
  assert.equal(seen.size,160);assert.ok(peak>0&&peak<=16);
  assert.equal(prepares,4,'Catalog batches should replace per-slot preparation.');
});
test('buffered context is not a claim or a paid admission and is discarded on failure',async()=>{
  let called=0;
  const next=preparedArtistBuffer({batchSize:64,prepare:async()=>[1,2,3,4]});
  await assert.rejects(rollingArtists({width:2,load:next,work:async id=>{
    called++;if(id===1)throw Error('provider stop');await new Promise(r=>setTimeout(r,2));
  },onError:()=>{}}),/provider stop/);
  assert.equal(called,2); // Prepared entries 3 and 4 never entered a paid slot.
});
test('sixteen-slot admission still blocks a seventeenth request and unknown charges',()=>{
  const f=fixture();f.width=16;
  f.pending=Array.from({length:15},(_,i)=>({operation_key:'op'+i,profile_id:'p'+i}));
  f.live=new Map(f.pending.map(p=>[p.operation_key,p.profile_id]));
  assert.doesNotThrow(()=>assertParallelAdmission(f));
  f.live.delete('op0');assert.throws(()=>assertParallelAdmission(f),/Unknown or abandoned/);
  f.live.set('op0','p0');f.pending.push({operation_key:'op16',profile_id:'p16'});
  assert.throws(()=>assertParallelAdmission(f),/Parallel request limit/);
});
test('deadline capacity ramps 32 to 64 to 128 and never exceeds its approved maximum',()=>{
  let time=1000;const capacity=gradualCapacity({now:()=>time});
  assert.equal(capacity(),32);time+=60000;assert.equal(capacity(),64);
  time+=60000;assert.equal(capacity(),128);time+=86400000;assert.equal(capacity(),128);
});
test('provider starts are paced separately with no call or reservation in the limiter',async()=>{
  let time=0;const observed=[];
  const pace=pacedAdmissions({intervalMs:50,now:()=>time,wait:async ms=>{time+=ms;}});
  for(let i=0;i<5;i++){await pace('metadata');observed.push(time);}
  assert.deepEqual(observed,[0,50,100,150,200]);
  await pace('search');assert.equal(time,200);
  await pace('search');assert.equal(time,250);
  assert.throws(()=>pace('other'));
});
test('128 slots and a 192-context buffer keep delayed claims unique and tier ordered',async()=>{
  const state=new Map(Array.from({length:768},(_,i)=>[String(i),{tier:i<384?1:2,status:'queued'}]));
  const seen=new Set();let active=0,peak=0;
  const load=preparedArtistBuffer({batchSize:192,prepare:async(n,prepared)=>{
    const exclude=new Set(prepared),tier=Math.min(...[...state.values()].filter(a=>a.status!=='done').map(a=>a.tier));
    return [...state].filter(([id,a])=>a.status==='queued'&&a.tier===tier&&!exclude.has(id)).slice(0,n).map(([id])=>id);
  }});
  await rollingArtists({width:128,load,work:async id=>{
    await new Promise(r=>setTimeout(r,Number(id)%3?1:4));
    const a=state.get(id);assert.equal(a.status,'queued');assert.ok(!seen.has(id));
    assert.ok([...state.values()].every(b=>b.tier>=a.tier||b.status==='done'));
    seen.add(id);a.status='active';active++;peak=Math.max(peak,active);
    await new Promise(r=>setTimeout(r,2));a.status='done';active--;
  },onError:()=>{}});
  assert.equal(seen.size,768);assert.ok(peak<=128);
});
test('rolling preparation failures close dispatch and drain a live response',async()=>{
  let loads=0,closed=false,saved=false,releaseSlow;
  const slow=new Promise(r=>{releaseSlow=r;});
  await assert.rejects(rollingArtists({width:2,load:async()=>{
    if(++loads===1)return [1,2];
    releaseSlow();throw Error('catalog failed');
  },work:async id=>{if(id===1){await slow;saved=true;}},onError:()=>{closed=true;}}),/catalog failed/);
  assert.equal(closed,true);assert.equal(saved,true);
});
test('a lower-tier artist finishing during an empty load does not end the campaign early',async()=>{
  let calls=0,release,finished;
  const slow=new Promise(r=>{release=r;});
  const done=new Promise(r=>{finished=r;});
  const seen=[];
  await rollingArtists({width:2,load:async()=>{
    calls++;
    if(calls===1)return [1,2];
    if(calls===2){release();await done;return [];}
    if(calls===3)return [3];
    return [];
  },work:async id=>{
    seen.push(id);if(id===1){await slow;finished();}
  },onError:()=>assert.fail('Unexpected failure')});
  assert.deepEqual(seen,[1,2,3]);
});
test('a lane failing during catalog preparation prevents newly prepared dispatch',async()=>{
  let loads=0,finishLoad,failLane,starts=0,closed=false;
  const preparing=new Promise(r=>{finishLoad=r;});
  await assert.rejects(rollingArtists({width:2,load:async()=>{
    if(++loads===1)return [1,2];
    failLane();await preparing;return [3];
  },work:async id=>{
    starts++;
    if(id===1)await new Promise((_,reject)=>{failLane=()=>{reject(Error('provider failed'));setImmediate(finishLoad);};});
  },onError:()=>{closed=true;}}),/provider failed/);
  assert.equal(starts,2);assert.equal(closed,true);
});
test('a failed lane closes dispatch immediately but drains the other response',async()=>{
  let closed=false,saved=false;
  await assert.rejects(drainBatch([1,2],async n=>{
    if(n===1){await new Promise(r=>setTimeout(r,5));throw Error('unsafe');}
    await new Promise(r=>setTimeout(r,15));assert.equal(closed,true);saved=true;
  },()=>{closed=true;}),/unsafe/);
  assert.equal(saved,true);
});
test('parallel transport persists unique charged responses and rejects duplicate requests before fetch',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'parallel-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(root+'/receipts');
  const admitted=new Set(),returned=new Set();let sent=0,active=0,max=0;
  const transport=priorityTransport({root,assertFrozen:async()=>{},credentials:{serper:'fixture'},
    admit:async op=>{assert.ok(!admitted.has(op.key),'duplicate');admitted.add(op.key);},
    returned:async op=>{returned.add(op.key);},
    fetchImpl:async()=>{sent++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));
      active--;return new Response('{"organic":[]}',{status:200});}});
  const request={method:'POST',url:'https://google.serper.dev/search',body:{q:'fixture artist',num:10}};
  await Promise.all(['1','2','3'].map(id=>transport(id,'search','search-'+id,request)));
  assert.equal(max,3);assert.equal(returned.size,3);
  await assert.rejects(transport('1','search','search-1',request),/duplicate/);assert.equal(sent,3);
});
test('128 real transport lanes share serialized mock admission and return transactions',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sixteen-admissions-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(root+'/receipts');
  const live=new Map(),admissions=new Map();let tail=Promise.resolve(),sent=0;
  const tx=fn=>{
    const result=tail.then(async()=>{await new Promise(r=>setTimeout(r,1));return fn();});
    tail=result.catch(()=>{});return result;
  };
  const transport=priorityTransport({root,assertFrozen:async()=>{},credentials:{serper:'fixture'},
    admit:op=>tx(()=>{
      const pending=[...admissions.values()].filter(a=>a.status==='admitted');
      assertParallelAdmission({...fixture(),width:128,artist:{profile_id:op.profileId,status:'in_progress'},live,pending});
      assert.ok(!admissions.has(op.key));
      admissions.set(op.key,{operation_key:op.key,profile_id:op.profileId,status:'admitted'});
      live.set(op.key,op.profileId);
    }),
    returned:op=>tx(()=>{
      assert.equal(admissions.get(op.key).status,'admitted');
      admissions.get(op.key).status='returned';live.delete(op.key);
    }),
    fetchImpl:async()=>{sent++;await new Promise(r=>setTimeout(r,4));
      return new Response('{"organic":[]}',{status:200});}});
  const request={method:'POST',url:'https://google.serper.dev/search',body:{q:'fixture artist',num:10}};
  await Promise.all(Array.from({length:128},(_,i)=>transport(String(i),'search','search-'+i,request)));
  assert.equal(sent,128);assert.equal(live.size,0);assert.equal(admissions.size,128);
  assert.ok([...admissions.values()].every(a=>a.status==='returned'));
});
test('diagnostics do not expose raw exception bodies or credentials',()=>{
  const out=safeDiagnostic(Object.assign(Error('sensitive provider body'),{code:'https://credential@example.test'}),'catalog_metadata');
  const {site,...summary}=out;
  assert.deepEqual(summary,{reason:'local_validation_or_catalog_failure_no_retry',errorClass:'Error',code:null,stage:'catalog_metadata'});
});
test('failure location is retained without raw assertion values or full paths',()=>{
  const error=Object.assign(Error('sensitive metadata'),{stack:'Error: sensitive metadata\n    at check (file:///private/location/campaign-parallel-core.mjs:24:10)'});
  assert.deepEqual(safeDiagnostic(error,'admission').site,{file:'campaign-parallel-core.mjs',line:24,column:10});
  assert.ok(!JSON.stringify(safeDiagnostic(error,'admission')).includes('sensitive'));
});
test('archive verification binds journal, receipt, request, charge and completed result',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'parallel-archive-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(root+'/receipts');await fs.mkdir(root+'/artists');
  const request={method:'POST',url:'https://fixture.invalid'},inputSha256=hash(request),key='operation';
  const packet={operationKey:key,kind:'search',request,inputSha256,status:200};
  await fs.writeFile(root+'/admissions.jsonl',JSON.stringify({key,profileId:'1',kind:'search',inputSha256,reservedCents:2})+'\n');
  await fs.writeFile(root+'/receipts/'+hash(key)+'.json',JSON.stringify(packet));
  await fs.writeFile(root+'/artists/1.json','{"artist":"fixture"}');
  const ledger={admissions:[{operation_key:key,profile_id:'1',kind:'search',input_sha256:inputSha256,
    reserved_cents:2,receipt_sha256:hash(packet),http_status:200}],
    artists:[{profile_id:'1',status:'completed',result_sha256:hash({artist:'fixture'})}]};
  await verifyArchive({root,runs:'youtube_link_campaigns'},ledger);
  ledger.admissions[0].http_status=500;
  await assert.rejects(verifyArchive({root,runs:'youtube_link_campaigns'},ledger));
});
