// Explicit, pre-dispatch sealing only. Cannot reset a launched campaign.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {evidenceDigest} from './youtube-ownership-policy.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {YOUTUBE_CAMPAIGN_ID as id,YOUTUBE_CAMPAIGN_ROOT as root} from './youtube-campaign-core.mjs';

export async function freezeLocalModules(entry,destination){
  const source=path.dirname(path.resolve(entry)),seen=new Set();
  await fs.mkdir(destination,{recursive:false});
  async function copy(file){
    if(seen.has(file))return;seen.add(file);
    assert.equal(path.dirname(file),source,'Unexpected dependency outside the scripts source folder.');
    const text=await fs.readFile(file,'utf8');
    await fs.writeFile(path.join(destination,path.basename(file)),text,{flag:'wx'});
    for(const m of text.matchAll(/(?:from\s*|import\s*\()\s*['"](\.\/[^'"]+\.mjs)['"]/g))
      await copy(path.resolve(path.dirname(file),m[1]));
  }
  await copy(path.resolve(entry));
  await fs.symlink(path.resolve('scripts/node_modules'),path.join(destination,'node_modules'),'dir');
  return seen;
}
async function main(){
  assert.deepEqual(process.argv.slice(2),['--seal-prepared']);
  const approval=JSON.parse(await fs.readFile(root+'/approval.json','utf8'));
  const queue=JSON.parse(await fs.readFile(root+'/queue.json','utf8'));
  assert.equal(approval.id,id);assert.equal(approval.maximumSpendCents,null);
  assert.equal(evidenceDigest(queue),approval.scopeSha256);
  const destination=path.resolve(root,'runtime');
  const copied=await freezeLocalModules('scripts/src/run-youtube-campaign.mjs',destination);
  const codeFingerprints=Object.fromEntries(await Promise.all(Object.keys(approval.codeFingerprints).map(async f=>[
    f,evidenceDigest(await fs.readFile(path.join(destination,path.basename(f)),'utf8'))])));
  const next={...approval,codeFingerprints,runtimeSealed:true,runtimeModules:copied.size};
  const pool=await connectSavedBatchPool(),c=await pool.connect();
  try{
    await c.query('BEGIN');
    const p=(await c.query('SELECT * FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[id])).rows[0];
    assert.equal(p.status,'prepared');assert.equal(Number(p.reserved_cents),0);
    assert.equal(p.approval_sha256,evidenceDigest(approval));
    const count=(await c.query('SELECT count(*)::int n FROM youtube_link_campaign_admissions WHERE campaign_id=$1',[id])).rows[0].n;
    assert.equal(count,0,'A dispatched campaign cannot change its frozen approval.');
    await fs.writeFile(root+'/approval.json.tmp',JSON.stringify(next));
    await c.query('UPDATE youtube_link_campaigns SET approval_sha256=$2 WHERE id=$1',[id,evidenceDigest(next)]);
    await fs.rename(root+'/approval.json.tmp',root+'/approval.json');
    await c.query('COMMIT');
    console.log(JSON.stringify({sealed:true,modules:copied.size,scopeUnchanged:true,paidCalls:0}));
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
