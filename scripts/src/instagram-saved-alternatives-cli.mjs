// Usage: node scripts/src/instagram-saved-alternatives-cli.mjs scope.json output-dir
// Dry-run by default; execution additionally requires --run-approved.
// Prepare a NEW scope with prepareSavedAlternativeScope. Never edit a running
// scope or reuse an earlier approval/budget identity to enable alternatives.
import fs from 'node:fs/promises';
import path from 'node:path';
import {digest,validateSavedAlternativeScope,capturedInstagramTransport} from './instagram-next-saved-batch.mjs';
import {openSavedAlternativeBatchGate,connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {frozenJevTransport} from './instagram-frozen-jev.mjs';
import {runSavedAlternatives} from './instagram-saved-alternatives-runner.mjs';

const args=process.argv.slice(2),run=args.includes('--run-approved');
const positional=args.filter(a=>a!=='--run-approved');
if(positional.length!==2)throw Error('Provide a frozen scope.json and a new output directory.');
const [file,out]=positional,scope=JSON.parse(await fs.readFile(file,'utf8'));
validateSavedAlternativeScope(scope);
const scopeSha256=digest(scope);
if(!run){
  console.log(JSON.stringify({scopeSha256,artists:scope.targets.length,
    inspectSavedAlternatives:scope.inspectSavedAlternatives,maximumSpendCents:scope.authorization.maxSpendCents,
    paidCalls:0,newSearches:0,liveLinkChanges:0}));
}else{
  await fs.mkdir(out,{recursive:false});
  await fs.mkdir(path.join(out,'metadata-responses'));
  await fs.mkdir(path.join(out,'model-responses'));
  await fs.writeFile(path.join(out,'scope.json'),JSON.stringify({scope,scopeSha256},null,2),{flag:'wx'});
  const metadata=capturedInstagramTransport({apiKey:process.env.SCRAPECREATORS_API_KEY,
    responseDir:path.join(out,'metadata-responses'),continueAcknowledgedServerErrors:true});
  const verifier=frozenJevTransport({apiKey:process.env.OPENROUTER_API_KEY,responseDir:path.join(out,'model-responses')});
  const transport={live:true,dispatch:request=>{
    if(request.kind==='scrapecreators_candidate')return metadata.dispatch(request);
    if(request.kind==='jev')return verifier.dispatch(request);
    throw Error('Provider kind not authorized.');
  }};
  const pool=await connectSavedBatchPool();
  let gate,writer;
  try{
    // Existing coordination schema is required. Never reset or replenish a row.
    await pool.query('INSERT INTO instagram_saved_batch_budgets (id,scope_sha256,cap_cents) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING',
      [scope.authorization.budgetId,scopeSha256,scope.authorization.maxSpendCents]);
    gate=await openSavedAlternativeBatchGate({pool,scope,scopeSha256,transport,journalPath:path.join(out,'admissions.jsonl')});
    writer=await fs.open(path.join(out,'outcomes.jsonl'),'wx');
    const result=await runSavedAlternatives({scope,gate,persist:async snapshot=>{
      await writer.write(JSON.stringify(snapshot)+'\n');await writer.sync();
    }});
    await fs.writeFile(path.join(out,'summary.json'),JSON.stringify(result,null,2),{flag:'wx'});
    console.log(JSON.stringify({status:result.status,stopReason:result.stopReason,
      budgetExhausted:result.budgetExhausted,budget:result.budget}));
    if(result.status==='stopped')process.exitCode=1;
  }finally{
    try{await gate?.close();await writer?.close();}finally{await pool.end();}
  }
}
