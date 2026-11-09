import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildShadowManifest,reconcileReservations} from './instagram-bulk-shadow-live.mjs';
const row={profile_id:'1',cm_artist:'2',artist:'Synthetic Musician',tier:3,tier_rank:1};
const accounts=[{profile_id:'1',account_id:'11',platform:'spotify',
  account_url:'https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA'}];
const audit={reservedCents:399,entries:[],fingerprint:'fixture'};
test('bounded generic cohort freezes all caps and has no artist-specific regression stage',()=>{
  const m=buildShadowManifest([row],accounts,'2026-11-09 01:30:12',audit);
  assert.equal(m.proposed_limits.artist_workers,5);assert.equal(m.authorization.maxSpendCents,500);
  assert.equal(m.artists[0].bucket,'automatic_shadow_cohort');
  assert.equal(m.selection.experimentalAcceptanceEnabled,false);assert.equal(m.selection.claimsAllowed,false);
});
test('separate 250-artist approval preserves original pilot cap and research-only restrictions',()=>{
  const approval={runId:'instagram-tiers-1-5-approved-250-usd20',maxArtists:250,maxSpendCents:2000};
  const m=buildShadowManifest([row],accounts,'2026-11-09 01:30:12',{...audit,reservedCents:732},approval);
  assert.equal(m.authorization.maxSpendCents,2000);
  assert.equal(m.authorization.originalPilotCapCents,1000);
  assert.equal(m.selection.claimsAllowed,false);
  assert.equal(m.proposed_limits.job_wall_time_minutes,60);
  assert.throws(()=>buildShadowManifest([row],accounts,'2026-11-09 01:30:12',audit,{...approval,maxSpendCents:2001}));
  assert.throws(()=>buildShadowManifest(Array(251).fill(row),accounts,'2026-11-09 01:30:12',audit,approval));
});
test('original budget, catalog identities, missing references, duplicates and prior admissions fail closed',()=>{
  for(const [rows,links,a] of [[[],accounts,audit],[[row],accounts,{...audit,reservedCents:501}],
    [[row],[],audit],[[row,row],accounts,audit],
    [[row],accounts,{...audit,entries:[{profileIds:['1']}]}],
    [[row],[...accounts,{profile_id:'1',account_id:'12',platform:'instagram'}],audit],
    [[{...row,profile_id:'invalid'}],accounts,audit]]){
    assert.throws(()=>buildShadowManifest(rows,links,'2026-11-09 01:30:12',a));
  }
});

test('reconciliation counts legacy and uncertain reservations without refunding or reading result streams',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bulk-reservation-test-'));
  try{
    await fs.writeFile(path.join(root,'admissions.jsonl'),[
      {phase:'admitted',key:'benchmark-22',reserveCents:6},
      {phase:'failed_no_retry',key:'benchmark-22'},
      {phase:'admitted',key:'regression-legacy-case',reserveCents:2},
    ].map(JSON.stringify).join('\n'));
    await fs.writeFile(path.join(root,'approved-scope.json'),JSON.stringify({cases:[{key:'regression-legacy-case',profileId:'23'}]}));
    await fs.writeFile(path.join(root,'results.jsonl'),'partial unrelated result stream');
    const r=await reconcileReservations(root);
    assert.equal(r.reservedCents,8);assert.deepEqual(r.entries[0].profileIds,['22','23']);
    assert.equal((await reconcileReservations(root,path.join(root,'admissions.jsonl'))).reservedCents,0);
    await fs.appendFile(path.join(root,'admissions.jsonl'),'\n{"phase":"admitted","key":"24-1","reserveCents":2}');
    const changed=await reconcileReservations(root);assert.equal(changed.reservedCents,10);
    assert.notEqual(changed.fingerprint,r.fingerprint);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('unknown historical identities and damaged admission evidence block launch',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bulk-reservation-invalid-'));
  try{
    await fs.writeFile(path.join(root,'admissions.jsonl'),'{"phase":');
    await assert.rejects(reconcileReservations(root),/Unreadable/);
    await fs.writeFile(path.join(root,'admissions.jsonl'),'{"phase":"admitted","key":"unknown-case","reserveCents":2}');
    await assert.rejects(reconcileReservations(root));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
