// Catalog reads and local exports only; no authorization or paid dispatch.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {prepareHundredSearch} from './prepare-youtube-hundred-search.mjs';
import {fiveHundredSearchPlan} from './youtube-five-hundred-search-plan.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
assert.deepEqual(process.argv.slice(2),['--prepare-only']);
const id='youtube-batch-500-staged-2026-11-16',root='generated-artifacts/'+id;
try{await fs.lstat(root);assert.fail('Fresh output required');}catch(e){if(e.code!=='ENOENT')throw e;}
await fs.mkdir(root);
const children=[],history=[];
for(let i=1;i<=5;i++){
  const childId='youtube-batch-100-fresh-500-2026-11-16-group-'+i;
  await prepareHundredSearch({id:childId,additionalHistory:history});
  const plan=JSON.parse(await fs.readFile('generated-artifacts/'+childId+'/plan.json'));
  children.push({id:childId,plan});history.push(...plan.artists);
  console.log(JSON.stringify({phase:'prepared_fresh_batch',artists:i*100,total:500,paidCalls:0}));
}
const runtimeFiles={};
for(const file of await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
  'run-youtube-five-hundred-search.mjs'),root+'/runtime')){
  runtimeFiles['runtime/'+path.basename(file)]=digest(await fs.readFile(file));
}
const plan=fiveHundredSearchPlan({id,preparedAt:new Date().toISOString(),children,runtimeFiles});
const save=(name,value)=>fs.writeFile(root+'/'+name,
  typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx'});
await save('plan.json',plan);
const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
const rows=plan.children.flatMap(c=>c.plan.children.flatMap(leaf=>leaf.plan.artists.map(a=>[
  a.artist,a.tier,a.profile_id,a.cm_artist,leaf.id,
  leaf.plan.operations.find(o=>o.profileId===a.profile_id).request.body.q,'0.02','Prepared only; not approved',
])));
await save('proposed-500-artists.csv','\ufeff'+[
  ['artist','tier','profile_id','cm_artist','search_cohort','exact_search_query','maximum_search_cost_usd','status'],
  ...rows,
].map(r=>r.map(cell).join(',')).join('\r\n'));
const summary={id,status:'prepared_not_approved',artists:500,tiers:plan.tiers,searchCalls:500,
  maximumNewSpendCents:1000,planSha256:digest(plan),paidCalls:0,ledgerWrites:0,catalogWrites:0,
  laterStagesRequireSeparateApproval:true};
await save('preparation.json',summary);console.log(JSON.stringify(summary));
