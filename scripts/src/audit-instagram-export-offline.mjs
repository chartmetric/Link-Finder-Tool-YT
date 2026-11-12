// Read-only saved-evidence triage. Never changes campaign decisions or ownership policy.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {auditLikelyCandidate} from './instagram-title-confusion-audit.mjs';
import {normalizedGuardName,guardNameAgreement} from './instagram-likely-review-policy.mjs';

const [inputFile,outDir]=process.argv.slice(2);
assert.ok(inputFile&&outDir,'Expected input JSON and output directory');
const rows=JSON.parse(await fs.readFile(inputFile,'utf8'));
const root='generated-artifacts/instagram-tier-priority';
const baseline=new Map(JSON.parse(await fs.readFile(root+'/baseline.json','utf8')).map(r=>[String(r.profileId),r]));
const owners=new Map();
for(const row of rows){
  const key=row.instagram_url.toLowerCase().replace(/\/$/,'');
  if(!owners.has(key))owners.set(key,new Set());
  owners.get(key).add(row.profile_id);
}
const csv=v=>{
  let s=v==null?'':String(v);
  if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
};
const fields=[...Object.keys(rows[0]),'audit_priority','audit_flags','account_display_name',
  'account_bio','saved_search_text','name_agrees_with_artist','exact_catalog_links_supplied',
  'recorded_positive_evidence_items','supplied_catalog_accounts','original_model_state_available',
  'distinct_artists_sharing_url','audit_limitation'];
await fs.mkdir(outDir,{recursive:true});
const all=await fs.open(outDir+'/all-matches-audit.csv','wx');
const flagged=await fs.open(outDir+'/flagged-for-review.csv','wx');
const unflagged=await fs.open(outDir+'/not-flagged-matches.csv','wx');
for(const handle of [all,flagged])await handle.write('\ufeff'+fields.map(csv).join(',')+'\r\n');
await unflagged.write('\ufeff'+Object.keys(rows[0]).map(csv).join(',')+'\r\n');
const summary={total:rows.length,flagged:0,notFlagged:0,priorities:{high:0,medium:0},
  flags:{},scoreBands:{below50:0,from50to69:0,from70to89:0,atLeast90:0,missing:0},
  paidCalls:0,catalogWrites:0,historicalDecisionsChanged:0,
  limitation:'Automated triage of saved evidence, not individual ownership verification. Flags can include legitimate aliases; not flagged does not mean verified. Numeric score bands are review aids, not a newly adopted acceptance policy.'};
const samples={};
try{
  for(let i=0;i<rows.length;i+=32){
    const group=await Promise.all(rows.slice(i,i+32).map(async row=>{
      assert.match(row.profile_id,/^\d+$/);
      let result;
      try{result=JSON.parse(await fs.readFile(root+'/artists/'+row.profile_id+'.json','utf8'));}
      catch(e){if(e.code!=='ENOENT')throw e;result=baseline.get(row.profile_id);}
      assert.equal(String(result?.profileId),row.profile_id);
      assert.equal(String(result?.cmArtist),row.cm_artist);
      const finding=result.candidates?.find(c=>c.url===row.instagram_url&&(c.reviewSuggestion===true||c.review?.reviewSuggestion===true));
      assert.ok(finding,'Missing exact positive saved candidate: '+row.profile_id);
      const state=finding.metadataActuallyUsed;
      const supplied=state?.candidates?.find(c=>c.url===row.instagram_url);
      const candidate=supplied?.candidate;
      const originalState=Boolean(state&&candidate);
      const score=finding.recordedAnswer?.sameIdentityProbability;
      assert.equal(String(score??finding.recordedAnswer?.score??''),row.score);
      const exact=Array.isArray(supplied?.observedExactCatalogLinks)?supplied.observedExactCatalogLinks.length:0;
      const evidence=(finding.decision??finding.review)?.evidence;
      const positive=Array.isArray(evidence)?evidence.length:0;
      const accounts=state?.catalogAccountEvidence?.accounts;
      const agrees=originalState?guardNameAgreement(row.artist_name,candidate.displayName,row.instagram_url):null;
      const norm=normalizedGuardName(row.artist_name);
      const bio=candidate?.bio??'',search=state?.savedSearchEvidence?.snippet??'';
      const phraseIn=t=>norm.length>=3&&normalizedGuardName(t).includes(norm);
      const flags=[];
      const noCorroboration=exact===0&&positive===0;
      const base=auditLikelyCandidate({artist:row.artist_name,tier:row.tier,profile_id:row.profile_id,cm_artist:row.cm_artist},finding);
      if(!originalState)flags.push('original_model_state_unavailable');
      if(Number.isFinite(score)&&score<0.5)flags.push('identity_score_below_50_percent');
      else if(Number.isFinite(score)&&score<0.7)flags.push('identity_score_50_to_69_percent');
      if(!Number.isFinite(score))flags.push('identity_score_unavailable');
      if(originalState&&agrees===false&&noCorroboration&&base.title_style_overlap)
        flags.push('possible_release_title_confusion');
      if(originalState&&agrees===false&&noCorroboration){
        if(phraseIn(bio))flags.push('different_account_name_artist_mentioned_in_bio');
        else if(phraseIn(search))flags.push('different_account_name_artist_only_in_search_text');
        else flags.push('different_account_name_no_recorded_corroboration');
      }
      const shared=owners.get(row.instagram_url.toLowerCase().replace(/\/$/,'')).size;
      if(shared>1)flags.push('account_shared_across_catalog_artists');
      const suspiciousMention=flags.some(f=>f==='possible_release_title_confusion'||f.startsWith('different_account_name_'));
      const high=(suspiciousMention&&Number.isFinite(score)&&score<0.7)||base.review_priority==='high'||shared>1;
      return {row,record:{...row,audit_priority:flags.length?(high?'high':'medium'):'not_flagged',
        audit_flags:flags.join('; '),account_display_name:candidate?.displayName??'',
        account_bio:bio,saved_search_text:search,name_agrees_with_artist:agrees,
        exact_catalog_links_supplied:originalState?exact:null,
        recorded_positive_evidence_items:positive,
        supplied_catalog_accounts:Array.isArray(accounts)?accounts.length:null,
        original_model_state_available:originalState,distinct_artists_sharing_url:shared,
        audit_limitation:summary.limitation},flags,score};
    }));
    for(const {row,record,flags,score} of group){
      const line=fields.map(k=>csv(record[k])).join(',')+'\r\n';
      await all.write(line);
      const band=!Number.isFinite(score)?'missing':score<0.5?'below50':score<0.7?'from50to69':score<0.9?'from70to89':'atLeast90';
      summary.scoreBands[band]++;
      if(flags.length){
        summary.flagged++;summary.priorities[record.audit_priority]++;
        await flagged.write(line);
        for(const flag of flags){
          summary.flags[flag]=(summary.flags[flag]??0)+1;
          if(!samples[flag])samples[flag]=[];
          if(samples[flag].length<5)samples[flag].push({artist:row.artist_name,url:row.instagram_url,score,displayName:record.account_display_name,bio:record.account_bio,search:record.saved_search_text});
        }
      }else{
        summary.notFlagged++;
        await unflagged.write(Object.keys(row).map(k=>csv(row[k])).join(',')+'\r\n');
      }
    }
    if(i%5000<32)console.log(JSON.stringify({reviewed:Math.min(i+32,rows.length),flagged:summary.flagged}));
  }
}finally{for(const h of [all,flagged,unflagged])await h.close();}
assert.equal(summary.total,summary.flagged+summary.notFlagged);
await fs.writeFile(outDir+'/summary.json',JSON.stringify(summary,null,2),{flag:'wx'});
await fs.writeFile(outDir+'/flag-samples.json',JSON.stringify(samples,null,2),{flag:'wx'});
console.log(JSON.stringify(summary));
