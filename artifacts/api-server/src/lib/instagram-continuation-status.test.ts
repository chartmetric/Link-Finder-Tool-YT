import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm,stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {continuationRequest} from "./instagram-continuation-status";

test("pending continuation evidence never overrides a later coordinator or launch",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"ig-continuation-"));
  try {
    const dir=path.join(root,"parallel-11111111-1111-1111-1111-111111111111");
    await mkdir(dir);
    const ids=Array.from({length:9404},(_,i)=>String(i+1));
    const file=path.join(dir,"tier-exception-scope.json");
    await writeFile(file,JSON.stringify(ids.map(profile_id=>({profile_id}))));
    const stamp=(await stat(file)).mtime.toISOString();
    assert.equal(await continuationRequest(root,new Set(ids),"2020-01-01T00:00:00Z"),stamp);
    assert.equal(await continuationRequest(root,new Set(ids),"2099-01-01T00:00:00Z"),null);
    assert.equal(await continuationRequest(root,new Set(ids.slice(1)),"2020-01-01T00:00:00Z"),null);
    await writeFile(path.join(dir,"launch-attempt.json"),"{}");
    assert.equal(await continuationRequest(root,new Set(ids),"2020-01-01T00:00:00Z"),null);
  } finally {await rm(root,{recursive:true,force:true});}
});
