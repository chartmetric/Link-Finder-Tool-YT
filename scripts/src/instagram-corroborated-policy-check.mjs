// Explicit local-file analysis. No transport, credentials, database or model calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {assessInstagramCandidates, CORROBORATED_POLICY, catalogReferences} from './musician-instagram-matching.mjs';
import {fitArtistContext, jevRequest} from './instagram-pilot-live-transport.mjs';
import {CORROBORATED_RUBRIC} from './instagram-ownership-rubric.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cell = value => {
  const text=String(value??'');
  return '"'+(/^[=+@-]/.test(text)?"'"+text:text).replaceAll('"','""')+'"';
};
const csv = rows => {
  const columns=Object.keys(rows[0]??{});
  return '\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';
};
async function checkSourceArchives(inputs) {
  const rows=[], artists=new Set(), observations=[], hashes=[];
  for(const input of inputs) {
    const read = async (name, expected) => {
      const bytes=await fs.readFile(path.join(input.directory,name)), sha256=hash(bytes);
      if(expected&&sha256!==expected)throw Error(`Frozen source changed: ${name}`);
      hashes.push({file:path.join(input.directory,name),sha256});
      return bytes.toString('utf8');
    };
    const manifest=JSON.parse(await read('approved-manifest.json',input.manifestSha256));
    const records=(await read('results.jsonl',input.resultsSha256)).split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
    const roster=new Map(manifest.artists.map(a=>[String(a.profile_id),a]));
    for(const record of records) {
      const artist=roster.get(String(record.profileId));
      if(!artist)throw Error('Source archive has an unbound artist.');
      artists.add(String(record.profileId)); observations.push(`${input.directory}:${record.profileId}`);
      const raw=record.rawResult??record.partialEvidence??{}, profiles=[...(raw.profiles??[])];
      const retained=new Set(profiles.map(p=>p.url));
      for(const attempt of record.discoveryAttempts??[])for(const p of attempt.profiles??[]) {
        if(!retained.has(p.url)){profiles.push(p);retained.add(p.url);}
      }
      let assessment, baseline, error='';
      try {
        baseline=assessInstagramCandidates({...raw,profiles},artist);
        assessment=assessInstagramCandidates({...raw,profiles},artist,{policy:CORROBORATED_POLICY,mode:'offline',
          context:{profileId:String(artist.profile_id),metadata:artist.metadata_context}});
      }catch(e){error=e.message;}
      for(const [index,p] of (profiles.length?profiles:[{}]).entries()) {
        const a=assessment?.candidates[index];
        rows.push({'Archive':path.basename(input.directory),'Artist':artist.artist,'Profile ID':String(artist.profile_id),
          'Instagram':p.url??'','Historical score':p.jevVerification?.sameIdentityProbability??'',
          'Historical verdict':p.jevVerification?.verdict??'',
          'Baseline supported':!!p.url&&!!baseline?.urls.includes(p.url),
          'Proposed research support':!!p.url&&!!assessment?.simulationUrls.includes(a?.url),
          'Proposed route':a?.route??'hold','Reason':error||a?.reason||'No candidate retained; not proof of account absence.',
          'Evidence':JSON.stringify(a?.evidence??[]),'Production approved':false,'New paid calls':0});
      }
    }
  }
  return {rows,hashes,summary:{distinctArtists:artists.size,artistOccurrences:observations.length,rows:rows.length,
    baselineSupported:rows.filter(r=>r['Baseline supported']).length,
    proposedResearchSupport:rows.filter(r=>r['Proposed research support']).length,
    candidateRowsWithoutModelAssessment:rows.filter(r=>r.Instagram&&!r['Historical verdict']).length,
    interpretation:'All retained candidate observations in the frozen source archives, including uninspected and incomplete work. Historical outputs, not a controlled prompt comparison or a labeled accuracy benchmark.'}};
}

export async function checkSavedCorroboratedPolicy(directory, output) {
  const bytes=await fs.readFile(path.join(directory,'prepared-scope.json'));
  const scope=JSON.parse(bytes);
  if (!Array.isArray(scope.cases)||!scope.cases.length) throw Error('Missing frozen cases.');
  const rows=[], inputHashes=[{file:'prepared-scope.json',sha256:hash(bytes)}];
  const statuses={};
  for(const c of scope.cases) for(const variant of ['candidate','control']) {
    const original=variant==='candidate'?c.profile:c.control.profile;
    const filename=`responses/${c.artist.profile_id}-${variant}.json`;
    const responseBytes=await fs.readFile(path.join(directory,filename));
    inputHashes.push({file:filename,sha256:hash(responseBytes)});
    const packet=JSON.parse(responseBytes);
    if(packet.status!==200||String(packet.profileId)!==String(c.artist.profile_id)) throw Error('Response/profile binding mismatch.');
    const requestHash=hash(JSON.stringify(packet.decisionRequest));
    if(requestHash!==packet.requestBodySha256) throw Error('Archived request hash mismatch.');
    const candidate=packet.decisionRequest.state.candidates[0];
    if(candidate.url!==original.url||packet.decisionRequest.state.artist!==c.artist.artist) throw Error('Archived candidate/artist binding mismatch.');
    const answers=packet.data.answers;
    const p=structuredClone(original);
    if (!catalogReferences(c.artist).some(r=>r.url===candidate.reference.url)) throw Error('Unbound archived reference.');
    // Controls use the target artist's reference, not the donor's reference.
    p.identityComparison.reference=structuredClone(candidate.reference);
    p.jevVerification={verdict:answers.candidate_0_verdict.choice,
      sameIdentityProbability:answers.candidate_0_same_identity.noul, model:packet.data.model};
    const result={profiles:[p],methodsUsed:[{method:'serper',status:'used'}]};
    const baseline=assessInstagramCandidates(result,c.artist);
    const assessment=assessInstagramCandidates(result,c.artist,{policy:CORROBORATED_POLICY,mode:'offline',
      context:{profileId:String(c.artist.profile_id),metadata:c.context}});
    const a=assessment.candidates[0];
    statuses[`${variant}:${a.route}`]=(statuses[`${variant}:${a.route}`]??0)+1;
    let proposedRequestSha256='', requestBytes='', omittedItems='', preparationError='';
    try {
      const request=jevRequest(fitArtistContext({artist:c.artist.artist,catalogReference:catalogReferences(c.artist)[0],
        profiles:[p],artistContext:c.context,ownershipRubric:CORROBORATED_RUBRIC},6000));
      proposedRequestSha256=hash(JSON.stringify(request));
      requestBytes=Buffer.byteLength(JSON.stringify(request));
      omittedItems=request.state.contextDelivery?.omittedItems??0;
    } catch(e) {preparationError=e.message;}
    rows.push({'Artist':c.artist.artist,'Profile ID':String(c.artist.profile_id),'Instagram':p.url,'Comparison':variant,
      'Historical model':packet.data.model,'Historical score':p.jevVerification.sameIdentityProbability,
      'Historical verdict':p.jevVerification.verdict,'Baseline supported':baseline.urls.includes(p.url),
      'Proposed research support':assessment.simulationUrls.includes(a.url),'Proposed route':a.route,
      'Reason':a.reason,'Evidence':JSON.stringify(a.evidence??[]),
      'Original request SHA256':requestHash,'Proposed unsent request SHA256':proposedRequestSha256,
      'Proposed request bytes':requestBytes,'Omitted context items':omittedItems,'Preparation hold':preparationError,
      'Production approved':false,'New paid calls':0});
  }
  const archiveCheck=await checkSourceArchives(scope.inputs??[]);
  inputHashes.push(...archiveCheck.hashes);
  const summary={policy:CORROBORATED_POLICY,rubric:CORROBORATED_RUBRIC,offlineOnly:true,
    targets:scope.cases.length,comparisons:rows.length,
    distinctControlAccounts:new Set(rows.filter(r=>r.Comparison==='control').map(r=>r.Instagram)).size,
    proposedTargetSupport:rows.filter(r=>r.Comparison==='candidate'&&r['Proposed research support']).length,
    proposedControlSupport:rows.filter(r=>r.Comparison==='control'&&r['Proposed research support']).length,
    baselineTargetSupport:rows.filter(r=>r.Comparison==='candidate'&&r['Baseline supported']).length,
    preparationHolds:rows.filter(r=>r['Preparation hold']).length,
    requestsWithOmissions:rows.filter(r=>r['Omitted context items']>0).length,
    statuses,sourceArchiveCheck:archiveCheck.summary,newPaidCalls:0,productionApproved:false,thresholdCalibrated:false,inputHashes,
    interpretation:'Counterfactual research-policy impact using historical model outputs and frozen source packets. No new model decisions. Convenience cohort; reused-account controls are not a diverse held-out benchmark. Source observations are historical, not current ownership approval. Synthetic safety tests do not measure accuracy.'};
  await fs.mkdir(output,{recursive:true});
  await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
  await fs.writeFile(path.join(output,'policy-impact.csv'),csv(rows));
  await fs.writeFile(path.join(output,'source-archive-impact.csv'),csv(archiveCheck.rows));
  return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [directory,output]=process.argv.slice(2);
  if(!directory||!output)throw Error('Usage: node instagram-corroborated-policy-check.mjs <frozen-directory> <output-directory>');
  const s=await checkSavedCorroboratedPolicy(directory,output);
  console.log(JSON.stringify({...s,inputHashes:`${s.inputHashes.length} frozen input hashes`},null,2));
}
