import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {evidenceDigest} from './youtube-ownership-policy.mjs';

export async function loadReturnedYoutubeReceipts(directory,allowed){
  const entries=(await fs.readFile(directory+'/admissions.jsonl','utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.length,new Set(entries.map(e=>e.key)).size);
  const packets=new Map(),receipts=new Map();
  for(const entry of entries){
    const expected=allowed.get(entry.key);
    assert.ok(expected);assert.equal(expected.kind,entry.kind);assert.equal(entry.reservedCents,2);
    if(expected.kind==='metadata')assert.equal(expected.inputSha256,entry.inputSha256);
    const packet=JSON.parse(await fs.readFile(directory+'/receipts/'+evidenceDigest(entry.key)+'.json','utf8'));
    assert.equal(packet.operationKey,entry.key);assert.equal(packet.kind,entry.kind);
    assert.equal(packet.inputSha256,entry.inputSha256);
    assert.equal(evidenceDigest(packet.request),entry.inputSha256);
    if(entry.kind==='model'){
      const prepared=JSON.parse(await fs.readFile(directory+'/model-inputs/'+evidenceDigest(entry.key)+'.json','utf8'));
      assert.equal(prepared.key,entry.key);assert.equal(prepared.requestSha256,entry.inputSha256);
      assert.equal(evidenceDigest(prepared.request),entry.inputSha256);
      assert.equal(prepared.readyForDispatch,true);
    }
    const receiptSha256=evidenceDigest(packet);
    packets.set(entry.key,packet);
    receipts.set(entry.key,{kind:entry.kind,inputSha256:entry.inputSha256,status:packet.status,receiptSha256});
  }
  return {packets,receipts};
}
export function reuseReturnedYoutubeRequest(packets,dispatch){
  return async(operation,request)=>{
    const saved=packets.get(operation.key);
    if(!saved)return dispatch(operation,request);
    assert.equal(saved.kind,operation.kind);assert.equal(saved.inputSha256,evidenceDigest(request));
    assert.equal(evidenceDigest(saved.request),evidenceDigest(request));
    return saved;
  };
}
export async function saveYoutubeArtifact(directory,name,value,{allowExisting=false}={}){
  try{await fs.writeFile(directory+'/'+name,JSON.stringify(value,null,2),{flag:'wx'});}
  catch(e){
    if(e.code!=='EEXIST'||!allowExisting)throw e;
    assert.equal(evidenceDigest(JSON.parse(await fs.readFile(directory+'/'+name,'utf8'))),evidenceDigest(value),
      'Existing evidence differs; do not overwrite or replay it.');
  }
}
