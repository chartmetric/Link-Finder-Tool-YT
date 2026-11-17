import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {parallelGate,boundedParallelArtists,reuseSourcePackets,validatedSourcePackets,
  validateSourceSnapshot,SOURCE_ID,SOURCE_ROOT,TARGET_ID} from './youtube-review-parallel.mjs';
const hash='a'.repeat(64),receiptHash='b'.repeat(64);
function fixture(sourceId=SOURCE_ID){
  let rows=[],ownReserved=0,before;const queries=[];
  const approval={scopeSha256:hash,artists:Array.from({length:100},(_,i)=>({profile_id:String(i+1)})),
    maxCalls:500,explicitApproval:true,approvalStatus:'approved',proposedCapCents:1000,
    userCapCents:1000,operationalCapCents:1000};
  const source={id:sourceId,owner:'old-owner',status:'stopped',reserved_cents:320,scope_sha256:hash,cap_cents:1000};
  const own={id:TARGET_ID,owner:'new-owner',status:'running',scope_sha256:hash,cap_cents:1000};
  const plan={id:TARGET_ID,sourceId,parentId:'parent',parallelism:16,sourceReservedCents:320,
    sourceSnapshot:{run:source},scopeSha256:hash,artists:approval.artists};
  const c={release(){},async query(q,a=[]){
    q=q.replace(/\s+/g,' ').trim();queries.push([q,a]);
    if(q==='BEGIN'){before=structuredClone({rows,ownReserved});return {};}
    if(q==='COMMIT')return {};
    if(q==='ROLLBACK'){({rows,ownReserved}=before);return {};}
    if(q.startsWith('SET LOCAL'))return {};
    if(q.startsWith('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(q.startsWith('SELECT * FROM youtube_discovery_test_runs'))
      return {rows:[a[0]===sourceId?{...source}:{...own,reserved_cents:ownReserved}]};
    if(q.startsWith('SELECT count(*)'))return {rows:[{n:q.includes('youtube_bounded_test_admissions')
      ?rows.filter(r=>r.status==='admitted'&&r.run_id!==a[0]).length:0}]};
    if(q.startsWith('SELECT operation_key,profile_id,kind,input_sha256'))return {rows:rows.filter(r=>
      r.run_id===a[0]&&r.status==='admitted').map(r=>({...r}))};
    if(q.startsWith('SELECT operation_key,kind,status'))return {rows:rows.filter(r=>
      a[0].includes(r.run_id)&&r.profile_id===a[1]).map(r=>({...r}))};
    if(q.startsWith('INSERT INTO youtube_bounded_test_admissions')){
      assert.ok(!rows.some(r=>r.run_id===a[0]&&r.operation_key===a[1]));
      rows.push({run_id:a[0],operation_key:a[1],profile_id:a[2],kind:a[3],
        input_sha256:a[4],status:'admitted'});return {rowCount:1};
    }
    if(q.startsWith('UPDATE youtube_discovery_test_runs SET reserved_cents')){
      if(ownReserved+2+a[1]>1000)return {rowCount:0};ownReserved+=2;return {rowCount:1};
    }
    if(q.startsWith("UPDATE youtube_bounded_test_admissions a SET status='returned'")){
      const r=rows.find(r=>r.run_id===a[0]&&r.operation_key===a[1]&&r.profile_id===a[2]&&
        r.input_sha256===a[3]&&r.status==='admitted'&&r.kind===a[7]&&own.owner===a[4]&&own.status==='running');
      if(!r)return {rowCount:0};
      r.status='returned';r.receipt_sha256=a[5];r.http_status=a[6];return {rowCount:1};
    }
    throw Error('Unexpected SQL '+q);
  }};
  const pool={connect:async()=>c};
  const gate=parallelGate({pool,plan,approval,owner:'new-owner'});
  return {gate,rows:()=>rows,spent:()=>ownReserved,source,own,plan,queries,
    setRows:r=>{rows=r;},setReserved:n=>{ownReserved=n;}};
}
const op=id=>({profileId:String(id),kind:'search',key:'search-'+id+'-0',inputSha256:hash});
test('a newly approved source ID remains bound to its stopped owner and shared original budget',async()=>{
  const id='youtube-test-100-review-repr-synthetic-source',f=fixture(id);
  await f.gate.admit(op(1));await f.gate.returned(op(1),receiptHash,200);
  assert.equal(f.spent(),2);
  assert.ok(f.queries.some(([q,a])=>q.includes('FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE')&&a[0]===id));
  assert.ok(f.queries.some(([q,a])=>q.startsWith('SELECT operation_key,kind,status')&&a[0].includes(id)));
});
test('sixteen live requests are allowed, a seventeenth is fenced, and already-sent receipts still drain',async()=>{
  const f=fixture();await Promise.all(Array.from({length:16},(_,i)=>f.gate.admit(op(i+1))));
  assert.equal(f.gate.live.size,16);assert.equal(f.spent(),32);assert.equal(f.rows().length,16);
  await assert.rejects(f.gate.admit(op(17)));
  await Promise.all(Array.from({length:16},(_,i)=>f.gate.returned(op(i+1),receiptHash,200)));
  assert.ok(f.rows().every(r=>r.status==='returned'));assert.equal(f.gate.live.size,0);
  await assert.rejects(f.gate.admit(op(18)));assert.equal(f.rows().length,16);
});
test('unknown pending work, overlapping artists and source-owner changes close dispatch',async()=>{
  const a=fixture();
  a.setRows([{run_id:TARGET_ID,profile_id:'99',operation_key:'search-99-0',kind:'search',
    input_sha256:hash,status:'admitted'}]);
  await assert.rejects(a.gate.admit(op(1)));assert.equal(a.rows().length,1);
  const b=fixture();await b.gate.admit(op(1));
  await assert.rejects(b.gate.admit({...op(1),kind:'metadata',key:'metadata-1-0'}));
  assert.equal(b.rows().length,1);await b.gate.returned(op(1),receiptHash,200);
  const d=fixture();d.source.owner='unexpected';
  // Keep expected source snapshot distinct, as a serialized plan is in reality.
  d.plan.sourceSnapshot=structuredClone(d.plan.sourceSnapshot);d.plan.sourceSnapshot.run.owner='old-owner';
  await assert.rejects(d.gate.admit(op(1)));assert.equal(d.rows().length,0);
});
test('the original $10 includes all prior reservations, not an additional $10 on continuation',async()=>{
  const f=fixture();f.setReserved(678);await f.gate.admit(op(1));
  assert.equal(f.spent()+f.source.reserved_cents,1000);
  await f.gate.returned(op(1),receiptHash,200);
  await assert.rejects(f.gate.admit(op(2)));
  assert.equal(f.spent(),680);assert.equal(f.rows().length,1);
});
test('receipt acknowledgement requires exact kind and input and preserves uncertain entries on mismatch',async()=>{
  const f=fixture();await f.gate.admit(op(1));
  await assert.rejects(f.gate.returned({...op(1),kind:'metadata'},receiptHash,200));
  assert.equal(f.rows()[0].status,'admitted');
  await f.gate.returned(op(1),receiptHash,500);
  assert.equal(f.rows()[0].status,'returned');assert.equal(f.rows()[0].http_status,500);
});
test('source history counts toward the five-call ceiling and cannot be replayed under a new run ID',async()=>{
  const f=fixture();f.setRows([
    ['search','search-1-0'],['metadata','metadata-1-a'],['metadata','metadata-1-b'],
    ['model','model-1-a'],['model','model-1-b'],
  ].map(([kind,key])=>({run_id:SOURCE_ID,profile_id:'1',operation_key:key,kind,status:'returned',input_sha256:hash})));
  await assert.rejects(f.gate.admit({...op(1),kind:'model',key:'model-1-c'}));
  assert.equal(f.spent(),0);assert.equal(f.rows().length,5);
});
test('saved bytes and ledger-bound receipts are verified, reused for free and never replaced when mismatched',async()=>{
  const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url=synthetic'},
    key='metadata-1-0',suffix=digest(key),raw=Buffer.from('{"success":true,"credits_charged":1}');
  const receipt={runId:SOURCE_ID,operationKey:key,profileId:'1',cmArtist:'2',kind:'metadata',
    request,inputSha256:digest(request),status:200,rawBodySha256:digest(raw),rawPath:'receipts/'+suffix+'.raw'};
  const admission={run_id:SOURCE_ID,operation_key:key,profile_id:'1',kind:'metadata',input_sha256:digest(request),
    status:'returned',http_status:200,receipt_sha256:digest(receipt),reserved_cents:2};
  const files=new Map([
    [SOURCE_ROOT+'/receipts/'+suffix+'.json',Buffer.from(JSON.stringify(receipt))],
    [SOURCE_ROOT+'/receipts/'+suffix+'.raw',raw],
    [SOURCE_ROOT+'/inputs/'+suffix+'.json',Buffer.from(JSON.stringify({op:{profileId:'1',kind:'metadata',
      key,inputSha256:digest(request)},request}))],
  ]);
  const p={artists:[{profile_id:'1',cm_artist:'2'}],sourceSnapshot:{admissions:[admission]}};
  const packets=await validatedSourcePackets(p,{readFile:async f=>files.get(f)});
  let dispatches=0;
  const cache=reuseSourcePackets(packets,async()=>{dispatches++;return 'new';});
  const returned=await cache.request('1','metadata',key,request);
  assert.equal(returned.rawBodyBase64,raw.toString('base64'));assert.equal(dispatches,0);
  await assert.rejects(cache.request('1','metadata',key,{...request,url:'https://different.example'}));
  assert.equal(dispatches,0);
  await cache.request('1','metadata','metadata-1-new',request);assert.equal(dispatches,1);
  files.set(SOURCE_ROOT+'/receipts/'+suffix+'.raw',Buffer.from('{}'));
  await assert.rejects(validatedSourcePackets(p,{readFile:async f=>files.get(f)}));
});
test('acknowledged 500s are preserved, but unknown paid outcomes prevent any continuation',()=>{
  const a={run_id:SOURCE_ID,operation_key:'search-1-0',profile_id:'1',kind:'search',input_sha256:hash,
    status:'returned',http_status:500,receipt_sha256:receiptHash,reserved_cents:2};
  const snapshot={run:{id:SOURCE_ID,status:'stopped',scope_sha256:hash,cap_cents:1000,reserved_cents:2},admissions:[a]};
  const plan={scopeSha256:hash,artists:[{profile_id:'1'}]};validateSourceSnapshot(snapshot,plan);
  assert.throws(()=>validateSourceSnapshot({...snapshot,admissions:[{...a,status:'admitted'}]},plan));
});
test('parallel artist queue reaches sixteen lanes, processes every artist once and drains on a fatal error',async()=>{
  const rows=Array.from({length:40},(_,i)=>({profile_id:String(i+1)}));
  let live=0,maximum=0,finished=0;const seen=new Set();
  await boundedParallelArtists(rows,16,async row=>{
    assert.ok(!seen.has(row.profile_id));seen.add(row.profile_id);
    maximum=Math.max(maximum,++live);await new Promise(r=>setTimeout(r,2));live--;finished++;
  },()=>assert.fail('No failure expected'));
  assert.equal(maximum,16);assert.equal(finished,40);assert.equal(live,0);
  let started=0,drained=0,closed=false;
  await assert.rejects(boundedParallelArtists(rows,16,async row=>{
    started++;await new Promise(r=>setTimeout(r,2));
    if(row.profile_id==='1')throw Error('synthetic fatal failure');drained++;
  },()=>{closed=true;}));
  assert.equal(started,16);assert.equal(drained,15);assert.equal(closed,true);
});
