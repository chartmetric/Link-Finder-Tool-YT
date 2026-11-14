// Read-only reconciliation and NEW local proposal files only. No approvals,
// coordinator mutations, provider requests, old-worker edits or catalog writes.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {prepareDirectRecoveryContract} from './youtube-direct-capture-recovery-plan.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {mixedHistoricalClaims,MIXED_PARENT} from './youtube-mixed-capture-readiness.mjs';
const source='generated-artifacts/youtube-batch-channel-checks-direct-100-refreshed-2026-11-13';
const root='generated-artifacts/youtube-direct-channel-recovery-preparation-2026-11-14';
const sourceFiles={};
const bytes=async file=>{const b=await fs.readFile(file);sourceFiles[file]=digest(b);return b;};
const read=async file=>JSON.parse(await bytes(file));
assert.deepEqual(process.argv.slice(2),['--prepare-only']);
try{await fs.lstat(root);assert.fail('Preparation exists; never overwrite');}catch(e){if(e.code!=='ENOENT')throw e;}
const bundle=await read(source+'/plan.json'),approval=await read(source+'/approval.json');
await bytes(source+'/run-started.json');
for(const [file,sha] of Object.entries(bundle.runtimeFiles))assert.equal(digest(await bytes(source+'/'+file)),sha);
const children=[];
for(const child of bundle.children){
  const folder='generated-artifacts/'+child.id,plan=await read(folder+'/plan.json');
  const childApproval=await read(folder+'/approval.json');
  for(const [file,sha] of Object.entries(plan.runtimeFiles))assert.equal(digest(await bytes(folder+'/'+file)),sha);
  for(const [file,sha] of Object.entries(plan.sourceFiles))assert.equal(digest(await bytes(file)),sha);
  children.push({plan,approval:childApproval});
}
const pool=await connectSavedBatchPool();let c,runs,admissions,savedResponses=[],contract,currentRows;
try{
  c=await pool.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1',[MIXED_PARENT])).rows[0]?.status,'stopped');
  for(const table of ['youtube_discovery_test_runs','youtube_video_stage_runs','youtube_link_campaigns','youtube_video_identity_runs'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='running'`)).rows[0].n,0);
  for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions','youtube_video_stage_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='admitted'`)).rows[0].n,0);
  const ids=bundle.children.map(ch=>ch.id);
  runs=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=ANY($1::text[]) ORDER BY id',[ids])).rows;
  admissions=(await c.query('SELECT * FROM youtube_video_identity_admissions WHERE run_id=ANY($1::text[]) ORDER BY run_id,created_at,operation_key',[ids])).rows;
  const globalPending=(await c.query("SELECT * FROM youtube_video_identity_admissions WHERE status='admitted'")).rows;
  assert.equal(globalPending.length,1);assert.ok(ids.includes(globalPending[0].run_id));
  for(const a of admissions){
    const folder='generated-artifacts/'+a.run_id,name='receipts/'+digest(a.operation_key);
    const receipt=await read(folder+'/'+name+'.json');
    assert.equal(receipt.rawPath,name+'.raw');
    const raw=await bytes(folder+'/'+receipt.rawPath);
    savedResponses.push({runId:a.run_id,receipt,rawBodyBase64:raw.toString('base64')});
  }
  const catalogClaims=await select(`SELECT toString(l.profile_id) profile_id,toString(p.cm_source_id) cm_artist,
    a.account_url FROM new_vertical.l_profile_account l FINAL
    INNER JOIN new_vertical.account a FINAL ON a.id=l.account_id
    LEFT JOIN new_vertical.profile p FINAL ON p.id=l.profile_id
    WHERE lower(a.platform)='youtube' AND notEmpty(trim(ifNull(a.account_url,'')))`);
  // Store only relevant catalog observations, never the entire catalog.
  const allAliases=new Set();
  const {normalizeYoutubeChannel}=await import('./youtube-ownership-transport.mjs');
  const {boundYoutubeCapture,returnedYoutubeUrl}=await import('./youtube-ownership-policy.mjs');
  for(const saved of savedResponses){
    const p=children.find(ch=>ch.plan.id===saved.runId).plan;
    const op=p.operations.find(o=>o.key===saved.receipt.operationKey);assert.ok(op);
    const capture=normalizeYoutubeChannel({at:saved.receipt.capturedAt,status:saved.receipt.status,kind:'metadata',
      operationKey:op.key,request:op.request,inputSha256:op.inputSha256,
      data:JSON.parse(Buffer.from(saved.rawBodyBase64,'base64'))},op.targetUrl);
    const bound=boundYoutubeCapture(op.targetUrl,capture);assert.ok(bound);
    bound.aliases.forEach(a=>allAliases.add(a.toLowerCase()));
  }
  const evidence={bundle,approval,children,runs,admissions,savedResponses,sourceFiles,
    catalogClaims:catalogClaims.filter(r=>allAliases.has(returnedYoutubeUrl(r.account_url)?.toLowerCase())),
    observedAt:new Date().toISOString()};
  // Serialize exactly the representation retained on disk (PG timestamps).
  const frozenEvidence=JSON.parse(JSON.stringify(evidence));
  contract=prepareDirectRecoveryContract(frozenEvidence);
  const selections=contract.continuation.pending.map(p=>p.selection);
  currentRows=await select(identityEligibilitySql(selections));
  const {assertNoNewIdentityClaims}=await import('./youtube-video-identity-execution.mjs');
  const claims=selections.map(s=>({alias:s.url,channelId:s.channelId,profileId:s.profileId,cmArtist:s.cmArtist}));
  assertNoNewIdentityClaims(claims,catalogClaims.map(r=>({alias:returnedYoutubeUrl(r.account_url)??'',
    channelId:returnedYoutubeUrl(r.account_url)?.match(/\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1]??null,
    profileId:String(r.profile_id),cmArtist:String(r.cm_artist)})));
  await mixedHistoricalClaims(c,claims);
  // Current metadata reservations are excluded independently by each identity.
  assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
    WHERE kind='metadata' AND (profile_id=ANY($1::text[]) OR cm_artist=ANY($2::text[]) OR channel_id=ANY($3::text[]))`,
    [selections.map(s=>s.profileId),selections.map(s=>s.cmArtist),
      contract.continuation.pending.map(p=>p.operation.allocationChannelKey)])).rows[0].n,0);
  await c.query('COMMIT');
  for(const [file,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
  await fs.mkdir(root);
  const save=(name,value)=>fs.writeFile(root+'/'+name,typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx'});
  let eligibilityStatus='current_eligibility_confirmed';
  try{assertCurrentIdentityEligibility(selections,currentRows);}catch{eligibilityStatus='requires_fresh_eligibility_before_execution';}
  await save('source-evidence.json',frozenEvidence);
  await save('recovery-and-continuation-proposal.json',contract);
  await save('current-eligibility.json',{observedAt:new Date().toISOString(),status:eligibilityStatus,rows:currentRows});
  const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  await save('remaining-channel-checks.csv','\ufeff'+[
    ['artist','tier_at_approval','profile_id','cm_artist','youtube_url','maximum_cost_usd','status'],
    ...contract.continuation.pending.map(p=>[p.selection.artist,p.selection.tier,p.operation.profileId,
      p.operation.cmArtist,p.operation.targetUrl,'0.02','Untouched — separate approval required'])
  ].map(r=>r.map(cell).join(',')).join('\r\n'));
  const manifest={status:contract.status,proposalSha256:digest(contract),
    evidenceSha256:digest(frozenEvidence),...contract.accounting,
    remainingChecks:contract.continuation.maximumCalls,maximumAdditionalCents:contract.continuation.maximumAdditionalCents,
    eligibilityStatus,paidCalls:0,coordinatorWrites:0,catalogWrites:0,
    next:'Implement and seal recovery-only execution against this evidence; obtain separate exact approval before acknowledging. Then seal and approve fresh remaining metadata stages. Do not rerun the old bundle.'};
  await save('preparation.json',manifest);
  await save('review.html',`<!doctype html><html lang="en"><meta charset="utf-8"><title>YouTube continuation preparation</title>
  <style>body{font:17px system-ui;line-height:1.6;max-width:760px;margin:60px auto;padding:0 24px;color:#153b37}h1{line-height:1.2}li{margin:12px 0}.note{background:#eff6f4;padding:18px;border-radius:10px}</style>
  <h1>YouTube batch: safe continuation plan</h1><p>Prepared for review only. Nothing was restarted.</p>
  <ul><li><b>${contract.accounting.previousAcknowledged} channel pages already recorded.</b> They will not be requested again.</li>
  <li><b>One saved response stays held.</b> Christian Liguori’s returned channel handle is linked to a different catalog profile.
  This does not prove a wrong match. Record the received response without approving the artist/channel connection.</li>
  <li><b>${contract.continuation.maximumCalls} untouched checks</b>, costing at most <b>$${(contract.continuation.maximumAdditionalCents/100).toFixed(2)}</b>.</li>
  <li><b>$${(contract.accounting.priorReservedCents/100).toFixed(2)} already reserved + $${(contract.continuation.maximumAdditionalCents/100).toFixed(2)} remaining = $${(contract.accounting.combinedMaximumCents/100).toFixed(2)}</b> maximum for the approved channel-checking stage.</li></ul>
  <p class="note">No paid calls, catalog changes, link approvals, or receipt acknowledgments were made during this preparation.
  Topic channels remain labeled as auto-generated. A channel capture is not proof of artist ownership.</p>
  <h2>Before restarting</h2><p>Seal and separately approve a recovery step for the saved response, leaving the conflict held and the old run stopped.
  Then recheck eligibility and approve a fresh plan containing only the untouched requests. The old batch must not be rerun.</p>
  <p>Preparation fingerprint: <small>${digest(contract)}</small></p></html>`);
  console.log(JSON.stringify(manifest));
}catch(error){if(c)await c.query('ROLLBACK').catch(()=>{});throw error;}
finally{c?.release();await pool.end();}
