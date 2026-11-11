import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {select,metadataQueries,buildMetadataOverlay} from './instagram-artist-metadata-overlay.mjs';
import {evidenceDigest,reviewYoutubeBatch,youtubeVerificationInput} from './youtube-ownership-policy.mjs';

const root='generated-artifacts/youtube-no-link-20-usd2';
const output=root+'/ownership-review-ready';
const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const save=(name,value)=>fs.writeFile(output+'/'+name,JSON.stringify(value,null,2),{flag:'wx'});
const readOptional=async p=>{try{return await json(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export async function reviewSavedYoutube(){
  const approval=await json(root+'/approval.json'),summary=await json(root+'/summary.json');
  assert.equal(summary.status,'completed');
  assert.equal(approval.scope.length,20);
  assert.equal(approval.scopeSha256,evidenceDigest(approval.scope));
  await fs.mkdir(output,{recursive:true});
  let overlay=await readOptional(output+'/catalog-evidence.json');
  if(!overlay){
    overlay=await readOptional(root+'/ownership-review/catalog-evidence.json');
    if(overlay)await save('catalog-evidence.json',overlay);
  }
  if(!overlay){
    const manifest={artists:approval.scope.map(t=>({...t,account_ids:[],accounts:[]}))};
    // Read-only catalog enrichment only. No provider fetches, claims, paid gates,
    // database changes, source-result replacements, or Instagram runner edits.
    const accounts=await select(metadataQueries(manifest).accounts.replaceAll("platform!='instagram'","platform!='youtube'"));
    for(const artist of manifest.artists){
      artist.accounts=accounts.filter(a=>a.profile_id===artist.profile_id);
      artist.account_ids=artist.accounts.map(a=>a.account_id);
    }
    const queries=metadataQueries(manifest),data={accounts};
    // Limit concurrent catalog reads while the real Instagram campaign continues.
    for(const key of Object.keys(queries).filter(k=>k!=='accounts'))
      data[key]=await select(queries[key].replaceAll("platform!='instagram'","platform!='youtube'"));
    overlay=buildMetadataOverlay(manifest,data,new Date().toISOString());
    await save('catalog-evidence.json',overlay);
  }
  assert.equal(overlay.packets.length,approval.scope.length);
  const inputs=[],records=[];
  for(const target of approval.scope){
    const saved=await json(root+'/artist-'+target.profile_id+'.json');
    assert.equal(saved.cm_artist,target.cm_artist);
    const p=overlay.packets.find(a=>a.profileId===target.profile_id);
    assert.ok(p);
    assert.equal(p.cmArtist,target.cm_artist);
    const artist={profileId:p.profileId,cmArtist:p.cmArtist,name:p.artist,catalogProfile:p.catalogProfile,
      country:p.chartmetric?.code2??null,label:p.chartmetric?.label??p.chartmetric?.record_label??null,
      accounts:p.linkedAccounts.filter(a=>a.platform!=='youtube'),releases:[...p.releases,...p.catalogTracks],
      context:{chartmetric:p.chartmetric,tags:p.tags,spotify:p.spotifyMetadata,
        platformSnapshots:p.platformSnapshots.filter(s=>s.platform!=='youtube'),profileMetadata:p.profileMetadata,
        warning:'Catalog context is not independently verified ownership; profile/platform snapshots are not account-bound captures.'}};
    const candidates=[];
    for(const c of saved.candidates){
      const key=evidenceDigest(c.url),capture=await readOptional(root+'/channel-captures/'+key+'.json');
      // Recorded answers must match the exact new evidence fingerprint.
      const recordedAnswer=await readOptional(root+'/channel-answers/'+key+'.json');
      const candidate={...c,capture,recordedAnswer};
      const input=youtubeVerificationInput(artist,candidate);
      inputs.push({profileId:p.profileId,cmArtist:p.cmArtist,url:c.url,...input});
      candidates.push(candidate);
    }
    records.push({artist,candidates,searchStatus:saved.status});
  }
  const reviewed=reviewYoutubeBatch(records);
  await save('verification-inputs.json',inputs);
  await save('artist-outcomes.json',reviewed);
  const rows=reviewed.flatMap(record=>record.candidates.length?record.candidates.map(({candidate,decision})=>({
    artist:record.artist.name,profile_id:record.artist.profileId,cm_artist:record.artist.cmArtist,
    candidateUrl:candidate.url,artistOutcome:record.outcome,...decision,
    searchTitle:candidate.title,searchSnippet:candidate.snippet,
    metadataActuallyUsed:youtubeVerificationInput(record.artist,candidate).state,
  })):[{artist:record.artist.name,profile_id:record.artist.profileId,cm_artist:record.artist.cmArtist,
    artistOutcome:record.outcome,status:record.outcome,reason:'Completed search returned no channel candidate; not proof of account absence.',
    verified:false,reviewSuggestion:false,metadataActuallyUsed:record.artist}]);
  const fields=[...new Set(rows.flatMap(Object.keys))];
  const cell=v=>{let s=typeof v==='object'&&v!==null?JSON.stringify(v):String(v??'');
    if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  await fs.writeFile(output+'/youtube-ownership-findings.csv','\ufeff'+[fields,...rows.map(r=>fields.map(f=>r[f]))]
    .map(r=>r.map(cell).join(',')).join('\r\n'),{flag:'wx'});
  const report={artists:reviewed.length,candidates:inputs.length,
    candidatesWithBoundChannelMetadata:inputs.filter(r=>r.readyForModel).length,
    likelyArtistOwned:reviewed.filter(r=>r.candidates.some(c=>c.decision.reviewSuggestion)).length,
    completedNoChannelResult:reviewed.filter(r=>r.outcome==='completed_no_channel_result').length,
    candidateStates:rows.reduce((out,row)=>(out[row.status]=(out[row.status]??0)+1,out),{}),
    possibleTopicCandidates:rows.filter(r=>r.channelType==='possible_topic').length,
    paidProviderCalls:0,modelCalls:0,databaseWrites:0,originalResultsChanged:false,
    note:'Offline evidence review, not a measured accuracy test. Search-only candidates still need channel captures and identity checks.'};
  await save('summary.json',report);
  console.log(JSON.stringify(report,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await reviewSavedYoutube();
