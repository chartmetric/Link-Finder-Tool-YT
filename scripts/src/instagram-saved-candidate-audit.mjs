// Local forensic audit only. No database, network, provider dispatch or decisions.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {instagramProfileUrl,catalogConnectionEvidence} from './musician-instagram-matching.mjs';
import {artistContextFromPacket} from './instagram-artist-metadata-overlay.mjs';
import {declaredInstagramLinks} from './instagram-reference-links.mjs';
import {musicPageUrl} from './public-music-links.mjs';
import {profileLinkDiagnostics} from './instagram-link-capture.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const norm=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const unique=values=>[...new Set(values.filter(Boolean))];
const json=value=>JSON.stringify(value);
const strings=value=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(strings)
  :value&&typeof value==='object'?Object.values(value).flatMap(strings):[];

export function releaseMentions(context,evidence) {
  const releases=unique((context?.items??[]).filter(i=>i.kind==='release')
    .map(i=>i.text.split(' — ')[0].replace(/\s\(\d{4}-\d{2}-\d{2}\)$/,'')))
    .filter(title=>norm(title).replaceAll(' ','').length>=5);
  const matches=[];
  for(const e of evidence) {
    const text=`${e.title??''} ${e.snippet??''}`;
    const normalized=` ${norm(text)} `;
    const hashtags=new Set([...text.matchAll(/#([\p{L}\p{N}_]+)/gu)]
      .map(m=>norm(m[1]).replaceAll(' ','')));
    for(const title of releases) {
      const exact=normalized.includes(` ${norm(title)} `);
      const hashtag=hashtags.has(norm(title).replaceAll(' ',''));
      if(!exact&&!hashtag)continue;
      matches.push({title,kind:e.kind,attribution:e.kind==='post_caption_owner'
        ?'candidate_owned_post_search_snippet':'other_or_unconfirmed_post_attribution',
        match:exact?'title_text':'hashtag',sourceUrl:e.sourceUrl,snippet:e.snippet??''});
    }
  }
  return matches;
}

/** Diagnostics are not ground-truth labels and never override saved scores. */
export function auditCandidate({artist,result,candidateUrl,discovered=[],profile,context,requestPacket}) {
  const comparison=profile?.identityComparison;
  const candidate=comparison?.candidate;
  const decision=profile?.jevVerification;
  const assessment=result.candidates?.find(c=>instagramProfileUrl(c.url)===candidateUrl);
  const evidence=[];
  for(const item of [...discovered,...(profile?[profile]:[])])for(const e of item.discoveryEvidence??[]) {
    if(!evidence.some(x=>json(x)===json(e)))evidence.push(e);
  }
  const request=requestPacket?.decisionRequest;
  const modelIndex=request?.state?.candidates?.findIndex(c=>instagramProfileUrl(c.url)===candidateUrl)??-1;
  const modelCandidate=modelIndex>=0?request.state.candidates[modelIndex]:undefined;
  const originalStrings=strings(modelCandidate).join('\n');
  const flags=[];
  const newPaths=candidate?catalogConnectionEvidence(candidate,artist):[];
  const unusedPaths=newPaths.filter(edge=>modelCandidate&&!modelCandidate.catalogConnections
    ?.some(old=>old.targetUrl===edge.targetUrl)&&edge.platform!==comparison.reference?.platform);
  if(unusedPaths.length)flags.push('alternate_catalog_binding_not_explicit_in_request');

  const declarations=(context?.items??[]).filter(i=>['bio','spotify_biography'].includes(i.kind))
    .flatMap(i=>declaredInstagramLinks(i.text).filter(d=>d.url===candidateUrl).map(d=>({
      ...d,source:i.source,sourceUrl:i.sourceUrl??'',asOf:i.asOf??'',stale:i.stale===true,
      binding:i.binding??'not_account_bound',
    })));
  const historicSignal=modelIndex>=0?request.state.artistContext?.candidateSignals?.[modelIndex]
    ?.otherPlatformBioLinksToCandidate:undefined;
  if(declarations.length&&modelCandidate&&historicSignal?.result!=='support')
    flags.push('saved_instagram_declaration_not_used_as_support');

  const mentions=releaseMentions(context,evidence);
  const own=mentions.filter(m=>m.attribution==='candidate_owned_post_search_snippet');
  const unusedOwn=own.filter(m=>modelCandidate&&!(originalStrings.includes(m.sourceUrl)&&originalStrings.includes(m.snippet)));
  if(unusedOwn.length)flags.push('catalog_release_in_owned_post_not_supplied');
  if(own.length&&!modelCandidate)flags.push('owned_post_release_not_assessed');
  if(declarations.length&&!modelCandidate)flags.push('saved_instagram_declaration_not_assessed');
  const artistName=norm(artist.artist).replaceAll(' ','');
  const handle=candidateUrl?.split('/').filter(Boolean).at(-1)??'';
  const nameConsistent=artistName.length>=3&&[handle,candidate?.displayName]
    .some(value=>norm(value).replaceAll(' ','').includes(artistName));
  const relatedContent=own.some(m=>/\b(fan[\s-]*made|fan[\s-]*(?:page|account)|mashup|reaction|tribute|cover)\b/i.test(m.snippet));
  const postCaution=own.length&&(!nameConsistent||relatedContent)
    ?'The posting account is not name-consistent with the artist, or the text indicates fan/related content. Release mention is not ownership support.'
    :'';

  const direct=candidate?.directExternalUrls??(candidate?.externalLinkEvidence?[]:candidate?.externalUrls??[]);
  const checked=new Set((candidate?.externalLinkEvidence?.attempts??[]).map(a=>a.sourceUrl));
  const unchecked=direct.filter(url=>musicPageUrl(url)&&!checked.has(musicPageUrl(url))
    &&!catalogConnectionEvidence({...candidate,directExternalUrls:[url]},artist).length);
  const unresolved=direct.filter(url=>!musicPageUrl(url)
    &&!catalogConnectionEvidence({...candidate,directExternalUrls:[url]},artist).length);
  if(unchecked.length)flags.push('supported_link_not_followed_in_saved_run');
  if(unresolved.length)flags.push('declared_link_outside_resolver_coverage');
  if(candidate&&!direct.length)flags.push('no_external_links_captured_not_proof_of_absence');
  if(!profile&&candidateUrl)flags.push('not_inspected');
  if(profile?.metadataLookupError)flags.push('metadata_lookup_failed');
  if(decision&&!modelCandidate)flags.push('original_decision_request_unavailable');
  const historicalCrossLink=!!modelCandidate?.observedExactCatalogLinks?.length
    || comparison?.status==='likely';
  if(decision&&!historicalCrossLink)flags.push('no_source_bound_cross_link_in_saved_assessment');
  if(decision?.sameIdentityProbability<0.9)flags.push('score_below_0_90');
  if(decision&&decision.verdict!=='verified')flags.push('verdict_not_verified');

  const missed=unusedPaths.length>0||(declarations.length>0&&historicSignal?.result!=='support')
    ||(!postCaution&&(unusedOwn.length>0||(own.length>0&&!modelCandidate)));
  let blocker;
  if(!candidateUrl)blocker=result.reason?'No candidates saved; processing incomplete':'No candidates found in completed search';
  else if(!profile)blocker='Candidate not inspected under the per-artist cap';
  else if(profile.metadataLookupError)blocker='Candidate metadata lookup failed';
  else if(!comparison)blocker='Identity metadata missing';
  else if(decision?.verdict==='mismatch')blocker='Model reported mismatch; not independently adjudicated';
  else if(!decision)blocker=result.reason||'No completed verifier decision';
  else if(!historicalCrossLink)blocker='No source-bound cross-link in saved assessment';
  else if(decision.sameIdentityProbability<0.9||decision.verdict!=='verified')blocker='Ownership confidence or verdict did not pass the gate';
  else blocker=assessment?.reason??'Inspect saved gate assessment';
  return {
    artist:artist.artist,instagram_link:candidateUrl??'',tier:artist.tier,profile_id:String(artist.profile_id),
    cm_artist:String(artist.cm_artist),priority:missed?'Review unused supporting evidence'
      :unchecked.length||unresolved.length?'Review missing link-path evidence'
      :!profile&&candidateUrl?'Uninspected retrieval clue':'No newly identified supporting evidence',
    main_blocker:blocker,audit_flags:flags,
    saved_verdict:decision?.verdict??'',saved_score:decision?.sameIdentityProbability??'',
    saved_gate_reason:assessment?.reason??'',artist_error:result.reason??'',
    candidate_stage:!candidateUrl?'no_saved_candidates':!profile?'not_inspected'
      :decision?'evaluated':profile.metadataLookupError?'metadata_failed':'no_completed_decision',
    original_request_available:!!modelCandidate,
    original_request_sha256:requestPacket?.requestBodySha256??'',
    historical_cross_link:historicalCrossLink,new_catalog_paths:newPaths,
    unused_catalog_paths:unusedPaths,saved_instagram_declarations:declarations,
    post_attribution_caution:postCaution,
    owned_post_release_matches:own,unused_owned_post_release_matches:unusedOwn,
    other_post_release_matches:mentions.filter(m=>m.attribution!=='candidate_owned_post_search_snippet'),
    unchecked_supported_links:unchecked,unresolved_declared_links:unresolved,
    link_capture_diagnostics:profileLinkDiagnostics(profile),
    captured_external_links:direct,candidate_name:candidate?.displayName??'',candidate_bio:candidate?.bio??'',
    discovery_source_urls:unique(evidence.map(e=>e.sourceUrl)),discovery_evidence:evidence,
    supported_link:(result.urls??[]).includes(candidateUrl),safe_for_import:false,
  };
}

export async function loadAuditRows(directories) {
  const rows=[],seen=new Set(),inputs=[];
  for(const dir of directories){
    const manifestBytes=await fs.readFile(path.join(dir,'approved-manifest.json'));
    const resultsBytes=await fs.readFile(path.join(dir,'results.jsonl'));
    const manifest=JSON.parse(manifestBytes);
    const overlay=JSON.parse(await fs.readFile(path.join(dir,'artist-context-evidence.json'),'utf8'));
    inputs.push({directory:dir,manifestSha256:hash(manifestBytes),resultsSha256:hash(resultsBytes)});
    const packetById=new Map(overlay.packets.map(p=>[String(p.profileId),p]));
    const requests=new Map();
    for(const file of await fs.readdir(path.join(dir,'responses'))){
      if(!/-jev-.*\.json$/.test(file))continue;
      const p=JSON.parse(await fs.readFile(path.join(dir,'responses',file),'utf8'));
      if(!p.decisionRequest)continue;
      if(p.requestBodySha256!==hash(json(p.decisionRequest)))throw Error('Archived decision request hash mismatch.');
      const id=String(p.profileId);
      if(requests.has(id))throw Error('Multiple verifier packets require explicit attribution, not last-write wins.');
      requests.set(id,p);
    }
    for(const result of resultsBytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse)){
      const id=String(result.profileId);
      if(seen.has(id))throw Error('Overlapping completed artist scopes; no silent deduplication.');
      seen.add(id);
      const artist=manifest.artists.find(a=>String(a.profile_id)===id);
      if(!artist)throw Error('Result artist absent from frozen manifest.');
      const packet=packetById.get(id);
      if(!packet||String(packet.cmArtist)!==String(artist.cm_artist))throw Error('Saved metadata identity conflict.');
      const context=artistContextFromPacket(packet);
      const raw=result.rawResult??result.partialEvidence??{};
      const attempts=result.discoveryAttempts??raw.discoveryAttempts??[];
      const all=new Map();
      for(const attempt of attempts)for(const p of attempt.profiles??[]){
        const url=instagramProfileUrl(p.url);if(!url)continue;
        if(!all.has(url))all.set(url,[]);all.get(url).push(p);
      }
      const inspected=new Map();
      for(const p of raw.profiles??[]){
        const url=instagramProfileUrl(p.url);if(!url)continue;
        if(inspected.has(url))throw Error('Conflicting duplicate inspected profile.');
        inspected.set(url,p);if(!all.has(url))all.set(url,[]);
      }
      if(!all.size)all.set('',[]);
      for(const [candidateUrl,discovered]of all){
        const row=auditCandidate({artist,result,candidateUrl,discovered,profile:inspected.get(candidateUrl),
          context,requestPacket:requests.get(id)});
        row.run_archive=path.basename(dir);
        rows.push(row);
      }
    }
  }
  rows.sort((a,b)=>a.artist.localeCompare(b.artist)||a.instagram_link.localeCompare(b.instagram_link));
  return {rows,inputs};
}

const columns=[
  ['Bio-link capture diagnostics','link_capture_diagnostics'],
  ['Artist name','artist'],['Instagram candidate link','instagram_link'],['Review priority','priority'],
  ['Main acceptance blocker','main_blocker'],['Audit findings','audit_flags'],['Saved verdict','saved_verdict'],
  ['Saved confidence score','saved_score'],['Candidate stage','candidate_stage'],['Tier','tier'],
  ['Unused catalog paths','unused_catalog_paths'],['Saved Instagram declarations','saved_instagram_declarations'],
  ['Unused owned-post release matches','unused_owned_post_release_matches'],
  ['Post attribution caution','post_attribution_caution'],
  ['Other post release mentions — not ownership proof','other_post_release_matches'],
  ['Supported links not followed','unchecked_supported_links'],['Unresolved declared links','unresolved_declared_links'],
  ['Captured external links','captured_external_links'],['Candidate display name','candidate_name'],
  ['Candidate bio','candidate_bio'],['Search source URLs','discovery_source_urls'],
  ['Search evidence','discovery_evidence'],['Original request available','original_request_available'],
  ['Original request SHA256','original_request_sha256'],['Saved gate reason','saved_gate_reason'],
  ['Artist processing error','artist_error'],['Profile ID','profile_id'],['Chartmetric artist ID','cm_artist'],
  ['Archive','run_archive'],['Accepted in saved run','supported_link'],['Safe for import','safe_for_import'],
];
const csvCell=value=>{
  let text=value==null?'':typeof value==='object'?json(value):String(value);
  if(/^\s*[=+\-@]|^[\t\r]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
};
export function auditCsv(rows){
  return [columns.map(c=>c[0]),...rows.map(r=>columns.map(c=>r[c[1]]))]
    .map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
export async function writeAudit({directories,outputDir}){
  const {rows,inputs}=await loadAuditRows(directories);
  const count=key=>Object.fromEntries(unique(rows.map(r=>r[key])).map(v=>[v,rows.filter(r=>r[key]===v).length]));
  const flags=unique(rows.flatMap(r=>r.audit_flags));
  const summary={
    mode:'offline_saved_evidence_audit',artists:new Set(rows.map(r=>r.profile_id)).size,
    candidateArtistPairs:rows.filter(r=>r.instagram_link).length,rows:rows.length,
    stages:count('candidate_stage'),priorities:count('priority'),
    findings:Object.fromEntries(flags.map(flag=>[flag,{
      candidates:rows.filter(r=>r.audit_flags.includes(flag)).length,
      artists:new Set(rows.filter(r=>r.audit_flags.includes(flag)).map(r=>r.profile_id)).size,
    }])),
    mainBlockers:count('main_blocker'),paidCalls:0,newSearches:0,databaseWrites:0,decisionsChanged:0,
    inputs,
    limitations:[
      'Not a measured false-negative rate or a new ownership decision. No model was rerun.',
      'Saved profile/platform bios remain context, not account-bound ownership proof.',
      'Post-owner attribution and title/hashtag matches come from search snippets, not newly fetched posts.',
      'Other accounts mentioning a release can be fans, collaborators or unrelated entities.',
      'No captured website is not proof no website exists; screenshot-only websites are not in archived provider data.',
      'Short titles under five letters/digits are excluded from release matching to limit incidental matches.',
    ],
  };
  await fs.mkdir(outputDir,{recursive:false});
  await fs.writeFile(path.join(outputDir,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});
  await fs.writeFile(path.join(outputDir,'all-candidates-audit.csv'),auditCsv(rows),{flag:'wx'});
  await fs.writeFile(path.join(outputDir,'unused-support-review.csv'),
    auditCsv(rows.filter(r=>r.priority==='Review unused supporting evidence')),{flag:'wx'});
  await fs.writeFile(path.join(outputDir,'candidate-audit-evidence.json'),JSON.stringify({summary,rows},null,2),{flag:'wx'});
  return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [outputDir,...directories]=process.argv.slice(2);
  if(!outputDir||!directories.length||process.argv.some(a=>a.startsWith('--')))
    throw Error('Usage: <new-output-directory> <saved-run-directory> [...]; offline only.');
  console.log(JSON.stringify(await writeAudit({directories,outputDir}),null,2));
}
