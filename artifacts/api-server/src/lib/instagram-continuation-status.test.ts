import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm,stat,utimes} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {continuationRequest} from "./instagram-continuation-status";

test("pending continuation evidence yields to newer coordinator evidence, not a mere launch attempt",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"ig-continuation-"));
  try {
    const dir=path.join(root,"parallel-11111111-1111-1111-1111-111111111111");
    await mkdir(dir);
    const ids=Array.from({length:9404},(_,i)=>String(i+1));
    const file=path.join(dir,"tier-exception-scope.json");
    await writeFile(file,JSON.stringify(ids.map(profile_id=>({profile_id}))));
    const stamp=(await stat(file)).mtime.toISOString();
    assert.deepEqual(await continuationRequest(root,new Set(ids),"2020-01-01T00:00:00Z"),
      {at:stamp,status:"continuation_requested"});
    assert.equal(await continuationRequest(root,new Set(ids),"2099-01-01T00:00:00Z"),null);
    assert.equal(await continuationRequest(root,new Set(ids.slice(1)),"2020-01-01T00:00:00Z"),null);
    await writeFile(path.join(dir,"launch-attempt.json"),"{}");
    assert.equal((await continuationRequest(root,new Set(ids),"2020-01-01T00:00:00Z"))?.status,"continuation_launching");
    assert.equal(await continuationRequest(root,new Set(ids),"2099-01-01T00:00:00Z"),null);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("failed, interrupted and launching preparation stays separate from coordinator evidence",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"ig-continuation-"));
  try {
    const name="parallel-11111111-1111-1111-1111-111111111111";
    const dir=path.join(root,name);
    await mkdir(dir);
    const ids=Array.from({length:9404},(_,i)=>String(i+1));
    const file=path.join(dir,"tier-exception-scope.json");
    await writeFile(file,JSON.stringify(ids.map(profile_id=>({profile_id}))));
    await utimes(file,new Date("2025-01-01Z"),new Date("2025-01-01Z"));
    const marker={version:1,phase:name,startedAt:"2025-01-01T00:00:00.000Z",at:"2025-01-02T00:00:00.000Z"};
    for (const [status,expected] of [
      ["preparing","continuation_requested"],["prepared","continuation_requested"],
      ["failed","continuation_preparation_failed"],["interrupted","continuation_preparation_interrupted"],
      ["launching","continuation_launching"],
    ]) {
      await writeFile(path.join(dir,"preparation-status.json"),JSON.stringify({...marker,status}));
      assert.deepEqual(await continuationRequest(root,new Set(ids),"2020-01-01Z"),{at:marker.at,status:expected});
      assert.equal(await continuationRequest(root,new Set(ids),"2025-01-01T12:00:00Z"),null,
        "New coordinator evidence supersedes the original request, even if the preparer exits later.");
    }
    await writeFile(path.join(dir,"preparation-status.json"),JSON.stringify({...marker,status:"handed_off"}));
    assert.equal((await continuationRequest(root,new Set(ids),"2020-01-01Z"))?.status,"continuation_launching");
    assert.equal(await continuationRequest(root,new Set(ids),"2025-01-03Z"),null);
    await writeFile(path.join(dir,"preparation-status.json"),JSON.stringify({...marker,status:"failed"}));
    await writeFile(path.join(dir,"launch-attempt.json"),"{}");
    assert.equal((await continuationRequest(root,new Set(ids),"2020-01-01Z"))?.status,"continuation_preparation_failed",
      "A launch failure before the coordinator advances must not regress the snapshot timestamp.");
    const newer=path.join(root,"parallel-22222222-2222-2222-2222-222222222222");
    await mkdir(newer);
    await writeFile(path.join(newer,"tier-exception-scope.json"),JSON.stringify(ids.map(profile_id=>({profile_id}))));
    await writeFile(path.join(newer,"launch-attempt.json"),"{}");
    await rm(path.join(dir,"launch-attempt.json"));
    assert.equal((await continuationRequest(root,new Set(ids),"2020-01-01Z"))?.status,"continuation_launching",
      "A newer launch must not revive an older failed request.");
    await rm(path.join(newer,"launch-attempt.json"));
    await writeFile(path.join(newer,"preparation-status.json"),"{}");
    await assert.rejects(continuationRequest(root,new Set(ids),"2020-01-01Z"),/Invalid/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("a vanished local preparer is interrupted, never worker activity",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"ig-continuation-"));
  try {
    const name="parallel-33333333-3333-3333-3333-333333333333",dir=path.join(root,name);
    await mkdir(dir);
    const ids=Array.from({length:9404},(_,i)=>String(i+1));
    await writeFile(path.join(dir,"tier-exception-scope.json"),JSON.stringify(ids.map(profile_id=>({profile_id}))));
    await writeFile(path.join(dir,"preparation-status.json"),JSON.stringify({
      version:1,phase:name,startedAt:"2025-01-01T00:00:00Z",at:"2025-01-01T00:00:00Z",
      status:"preparing",pid:2147483647,hostname:os.hostname(),
    }));
    assert.equal((await continuationRequest(root,new Set(ids),"2020-01-01Z"))?.status,"continuation_preparation_interrupted");
  } finally {await rm(root,{recursive:true,force:true});}
});
