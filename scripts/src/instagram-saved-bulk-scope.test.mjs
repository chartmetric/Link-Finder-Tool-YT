import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareSavedBulk} from './instagram-saved-bulk-scope.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
test('500-artist scope is source-only, uses non-target controls and explicitly holds sparse and oversized Unicode evidence',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'saved-scope-')),source=path.join(dir,'source');
  const savedFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No providers during preparation');};
  try{
    await fs.mkdir(source);
    const artists=[],results=[];
    for(let i=1;i<=505;i++){
      const name=i===7?'界'.repeat(3000):`Artist ${i}`,music=`https://open.spotify.com/artist/${String(i).padStart(22,'0')}`;
      artists.push({profile_id:String(i),cm_artist:String(i),artist:name,tier:2,tier_rank:i,
        account_ids:[`a${i}`],accounts:[{platform:'spotify',account_id:`a${i}`,account_url:music}],
        source_identity_matches:true,reference_preflight:{readiness:'reference_usable'}});
      results.push({profileId:String(i),rawResult:{profiles:Array.from({length:i<=5?6:1},(_,j)=>{
        const url=`https://www.instagram.com/artist_${i}_${j}/`;
        return {url,identityComparison:i===6?undefined:{status:'mismatch',reasons:['OLD JUDGMENT MUST NOT REACH MODEL'],
          reference:{url:music,platform:'spotify',displayName:name},
          candidate:{url,displayName:name,bio:'Singer',externalUrls:[music]}},
          jevVerification:{verdict:'mismatch',sameIdentityProbability:0.01}};
      })}});
    }
    await fs.writeFile(path.join(source,'approved-manifest.json'),JSON.stringify({artists}));
    await fs.writeFile(path.join(source,'results.jsonl'),results.map(r=>JSON.stringify(r)).join('\n'));
    const outputDir=path.join(dir,'prepared'),summary=await prepareSavedBulk({directories:[source],outputDir});
    assert.equal(summary.artistRecords,500);assert.equal(summary.paidEligibleArtists,498);
    assert.equal(summary.controlAccounts,30);assert.equal(summary.controlSourceArtists,5);
    const scope=JSON.parse(await fs.readFile(path.join(outputDir,'scope.json'),'utf8'));
    const rows=JSON.parse(await fs.readFile(path.join(outputDir,'source-rows.json'),'utf8'));
    assert.ok(rows.some(r=>r.profileId==='6'&&r.reason==='saved_account_metadata_unavailable'));
    assert.ok(rows.some(r=>r.profileId==='7'&&r.status==='held_without_call'));
    assert.equal(scope.requests.filter(r=>r.role==='control').length,30);
    const targets=new Set(scope.artists.map(a=>String(a.profile_id)));
    for(const row of rows.filter(r=>r.role==='control'))assert.equal(targets.has(row.sourceProfileId),false);
    for(const r of scope.requests){
      const text=JSON.stringify(r.body);assert.equal(hash(text),r.sha256);assert.equal(Buffer.byteLength(text),r.bytes);
      assert.ok(r.bytes<=6000);assert.doesNotMatch(text,/OLD JUDGMENT|identityComparisonStatus|identityComparisonReasons|jevVerification/);
    }
    await assert.rejects(prepareSavedBulk({directories:[source],outputDir}),{code:'EEXIST'});
  }finally{globalThis.fetch=savedFetch;await fs.rm(dir,{recursive:true,force:true});}
});
