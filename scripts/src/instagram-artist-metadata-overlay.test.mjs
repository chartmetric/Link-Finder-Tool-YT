import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildMetadataOverlay,metadataQueries,metadataCsv,enrichSavedBatch} from './instagram-artist-metadata-overlay.mjs';
const manifest={artists:[{profile_id:'1',cm_artist:'2',artist:'=Synthetic Artist',tier:3,account_ids:['3'],
  accounts:[{account_id:'3',platform:'spotify',account_url:'https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA'}]}]};
const data=()=>({catalogProfiles:[{profile_id:'1',cm_artist:'2',name:'Synthetic'}],
  accounts:[{profile_id:'1',account_id:'3',platform:'spotify',account_url:'https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA'}],
  snapshots:[{profile_id:'1',platform:'spotify',latest:['bio','name','','2026-11-01','2026-11-01']}],
  chartmetric:[{cm_artist:'2',code2:'GB'}],tags:[],spotify:[],profileMetadata:[]});
test('metadata is supplemental, provenance-tagged, non-importable and never ownership proof',()=>{
  const r=buildMetadataOverlay(manifest,data(),'2026-11-10');
  assert.equal(r.counts.withSavedBio,1);assert.equal(r.counts.withCountry,1);
  assert.equal(r.counts.withSpotifyBiography,0);assert.equal(r.paidProviderCalls,0);
  assert.equal(r.packets[0].ownershipConfirmed,false);
  assert.equal(r.packets[0].platformSnapshots[0].binding,'profile_and_platform_only_not_account_bound');
  assert.ok(metadataCsv(r).includes(`"'=Synthetic Artist"`));
});
test('changed identities and malformed scopes fail closed; ambiguous or newly linked bios stay held',()=>{
  assert.throws(()=>metadataQueries({artists:[{profile_id:'1); DROP',cm_artist:'2'}]}));
  const changed=data();changed.catalogProfiles[0].cm_artist='999';
  assert.throws(()=>buildMetadataOverlay(manifest,changed,'now'),/identity changed/);
  const d=data();d.accounts.push({...d.accounts[0],account_id:'4'});
  const r=buildMetadataOverlay(manifest,d,'now');
  assert.equal(r.counts.withSavedBio,0);
  assert.equal(r.packets[0].platformSnapshots[0].usableAsContext,false);
  d.accounts=d.accounts.filter(a=>a.account_id==='4');
  assert.equal(buildMetadataOverlay(manifest,d,'now').counts.withSavedBio,0);
});
test('fixture enrichment executes only bounded SELECTs, preserves original files and refuses overwrite',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'artist-metadata-'));
  try {
    const original=JSON.stringify(manifest);await fs.writeFile(path.join(dir,'approved-manifest.json'),original);
    await fs.writeFile(path.join(dir,'results.jsonl'),'unchanged');
    const keys=Object.keys(metadataQueries(manifest));let n=0;
    const out=await enrichSavedBatch(dir,{query:async sql=>{
      assert.ok(sql.startsWith('SELECT'));assert.ok(!/INSERT|UPDATE|DELETE/.test(sql));
      return data()[keys[n++]];
    }});
    assert.equal(n,7);assert.equal(out.artists,1);
    assert.equal(await fs.readFile(path.join(dir,'results.jsonl'),'utf8'),'unchanged');
    assert.equal(await fs.readFile(path.join(dir,'approved-manifest.json'),'utf8'),original);
    await assert.rejects(enrichSavedBatch(dir,{query:()=>{throw Error('Must not run');}}),/EEXIST/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
