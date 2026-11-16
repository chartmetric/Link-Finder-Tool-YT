// Cache content hashes, not permission to change files. Every invocation still
// checks every file's identity, size and nanosecond modification/change times.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {digest} from './youtube-video-discovery-offline.mjs';
const signature=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode].join(':');
export function frozenFileVerifier(files,{concurrency=16,readFile=fs.readFile,lstat=fs.lstat}={}){
  assert.ok(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=32);
  const entries=Object.entries(files),cache=new Map();
  for(const [file,sha] of entries){
    assert.match(file,/^generated-artifacts\/[A-Za-z0-9_./-]+$/);
    assert.ok(!file.split('/').includes('..'));assert.match(sha,/^[a-f0-9]{64}$/);
  }
  return async()=>{
    let cursor=0,reads=0;
    await Promise.all(Array.from({length:Math.min(concurrency,entries.length)},async()=>{
      for(;;){
        const i=cursor++;if(i>=entries.length)return;
        const [file,sha]=entries[i],before=await lstat(file,{bigint:true});
        assert.ok(before.isFile()&&!before.isSymbolicLink(),'Nonregular frozen file: '+file);
        // Resolve parent-directory aliases too, not only final-file symlinks.
        assert.equal(await fs.realpath(file),path.resolve(file),'Symlink evidence: '+file);
        const key=signature(before);
        if(cache.get(file)===key)continue;
        const bytes=await readFile(file);reads++;
        const after=await lstat(file,{bigint:true});
        assert.equal(signature(after),key,'Frozen file changed while reading: '+file);
        assert.equal(digest(bytes),sha,'Frozen contents changed: '+file);
        cache.set(file,key);
      }
    }));
    return {filesChecked:entries.length,contentReads:reads};
  };
}
