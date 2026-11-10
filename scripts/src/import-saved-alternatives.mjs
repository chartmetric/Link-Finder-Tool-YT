// Offline archive adapter. No provider, coordinator, discovery or catalog imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const states = ['uninspected','unavailable','inconclusive','unsupported','positive_review_suggestion'];
const field = (label,value,group='raw') => ({
  label, value: value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value), group,
});
const money = cents => `$${(cents / 100).toFixed(2)}`;
const urlOk = value => typeof value === 'string' && /^https:\/\/www\.instagram\.com\/[A-Za-z0-9_.]+\/$/.test(value);

export async function buildSavedAlternativesDocument(directory) {
  const provenance = [];
  async function read(name,optional=false) {
    let bytes;
    try { bytes=await fs.readFile(path.join(directory,name)); }
    catch(e) { if(optional && e.code==='ENOENT') return null; throw e; }
    if(bytes.length>40*1024*1024) throw Error(`Archive file too large: ${name}`);
    provenance.push({file:name,sha256:hash(bytes)});
    return bytes.toString('utf8');
  }
  const frozen=JSON.parse(await read('scope.json'));
  const scope=frozen.scope, scopeSha256=digest(scope);
  if(scopeSha256!==frozen.scopeSha256 || !Array.isArray(scope.targets) || !scope.targets.length)
    throw Error('Frozen scope identity mismatch.');
  const auth=scope.authorization;
  if(auth?.approved!==true || auth.candidateMetadataFetchesApproved!==true
    || !auth.budgetId || !Number.isInteger(auth.maxSpendCents) || auth.maxSpendCents<1 || auth.maxSpendCents>2000
    || typeof scope.inspectSavedAlternatives!=='boolean'
    || (scope.inspectSavedAlternatives && auth.savedAlternativesApproved!==true))
    throw Error('Missing saved-alternative approval.');
  const targets=new Map();
  for(const t of scope.targets) {
    const id=String(t.profileId);
    if(targets.has(id) || !id || !Array.isArray(t.candidates)
      || t.candidates.some(c=>!urlOk(c.url))
      || new Set(t.candidates.map(c=>c.url)).size!==t.candidates.length
      || JSON.stringify(t.candidates.map(c=>c.url))!==JSON.stringify(t.player?.savedCandidateUrls))
      throw Error('Invalid frozen candidate identities.');
    targets.set(id,t);
  }
  // Require complete journal lines. Never silently discard a torn admission.
  const admissions=(await read('admissions.jsonl')).split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
  const checkpoints=(await read('outcomes.jsonl')).split('\n').filter(l=>l.trim()).map(l=>JSON.parse(l));
  const summaryText=await read('summary.json',true);
  const latest=checkpoints.at(-1);
  const result=summaryText ? JSON.parse(summaryText) : latest;
  if(!result || (summaryText && JSON.stringify(result)!==JSON.stringify(latest)))
    throw Error('Summary and last durable checkpoint differ or no checkpoint exists.');
  const budget=result.budget;
  if(budget?.budgetId!==auth.budgetId || budget.scopeSha256!==scopeSha256
    || budget.maximumSpendCents!==auth.maxSpendCents
    || !Number.isInteger(budget.reservedCents) || budget.reservedCents<0
    || budget.reservedCents>auth.maxSpendCents)
    throw Error('Parent budget does not match the frozen scope.');
  const requests=new Map(), receipts=new Map(), captures=new Map();
  for(const event of admissions) {
    if(!Number.isFinite(Date.parse(event.at))) throw Error('Journal timestamp is missing.');
    if(event.phase==='admitted') {
      const r=event.request, t=targets.get(String(event.profileId));
      if(!r || !t || requests.has(event.key) || r.key!==event.key
        || String(r.profileId)!==String(event.profileId) || event.reservedCents!==2
        || digest(r.body)!==r.sha256 || !['jev','scrapecreators_candidate'].includes(r.kind))
        throw Error('Invalid exact admitted request receipt.');
      const url=r.kind==='jev' ? r.body?.state?.savedSearchEvidence?.url : r.body?.url;
      if(!t.candidates.some(c=>c.url===url) || (!scope.inspectSavedAlternatives && t.candidates[0]?.url!==url))
        throw Error('Admitted request is outside the saved scope.');
      requests.set(event.key,{...r,url,admission:event});
    } else if(event.phase==='returned') {
      if(!requests.has(event.key) || receipts.has(event.key)) throw Error('Returned receipt has no unique admission.');
      receipts.set(event.key,event);
    } else if(event.phase!=='stopped_no_retry') throw Error('Unknown journal phase.');
  }
  for(const [key,r] of requests) {
    if(!/^[a-z0-9-]+$/.test(key)) throw Error('Unsafe archive response key.');
    const file=`${r.kind==='jev'?'model':'metadata'}-responses/${key}.json`;
    const raw=await read(file,true);
    const capture=raw ? JSON.parse(raw) : null;
    if(capture && r.kind==='jev'
      && (capture.requestBodySha256!==r.sha256 || digest(capture.decisionRequest)!==r.sha256))
      throw Error('Captured model request differs from its admission.');
    if(capture && r.kind==='scrapecreators_candidate' && capture.requestedUrl!==r.url)
      throw Error('Captured metadata response differs from its requested account.');
    captures.set(key,{file,capture});
  }
  const rows=[], seen=new Set();
  // A later durable checkpoint is a new immutable observation, not a replacement.
  const batchId=`saved-alternatives-${scopeSha256.slice(0,24)}-${digest(result).slice(0,16)}`;
  for(const artist of result.artists ?? []) {
    const pid=String(artist.profileId), target=targets.get(pid);
    if(!target || seen.has(pid) || artist.artist!==target.artist
      || JSON.stringify(artist.candidates.map(c=>c.url))!==JSON.stringify(target.candidates.map(c=>c.url))
      || artist.liveLinkAccepted!==false || artist.verified!==false)
      throw Error('Checkpoint artist does not match the frozen scope or claims accepted links.');
    seen.add(pid);
    if(!artist.candidates.length && artist.status!=='no_saved_candidate') throw Error('Missing no-saved-candidate state.');
    for(const [index,c] of (artist.candidates.length?artist.candidates:[null]).entries()) {
      if(c && !states.includes(c.status)) throw Error('Unknown candidate inspection status.');
      if(c?.metadata?.available && c.metadata.candidate?.url!==c.url) throw Error('Captured metadata account mismatch.');
      const relevant=[...requests.values()].filter(r=>
        r.url===c?.url && (r.kind==='scrapecreators_candidate' || String(r.profileId)===pid));
      const verifier=relevant.find(r=>r.kind==='jev');
      if(c?.metadata && !relevant.some(r=>r.kind==='scrapecreators_candidate' && receipts.has(r.key)))
        throw Error('Captured metadata has no completed exact-account receipt.');
      if(c?.requestSha256 && (!verifier || c.requestSha256!==verifier.sha256 || !receipts.has(verifier.key)))
        throw Error('Candidate request hash has no completed exact admission.');
      const fields=[
        field('Artist name',target.artist,'identity'), field('Profile ID',pid,'identity'),
        field('Chartmetric artist ID',artist.cmArtist,'identity'),
        field('Candidate Instagram link',c?.url,'identity'), field('Verified Instagram link','','identity'),
        field('Candidate inspection status',c?.status ?? 'no_saved_candidate','decision'),
        field('Candidate reason',c?.reason ?? 'No URL in frozen saved scope','decision'),
        field('Artist checkpoint status',artist.status,'decision'),
        field('Candidate order in frozen scope',c ? index+1 : null,'provenance'),
        field('Live-link interpretation','Read-only review. No accepted link or verified ownership.','decision'),
        field('Review-only suggestion (JSON)',c?.review,'decision'),
        field('Recorded model answer (JSON)',c?.recordedAnswer,'decision'),
        field('Captured candidate metadata receipt (JSON)',c?.metadata,'metadata'),
        field('Frozen saved candidate available, not necessarily sent (JSON)',target.candidates[index],'metadata'),
        field('Frozen artist context available, not necessarily sent (JSON)',target,'metadata'),
        field('Exact request delivery status',verifier
          ? `Journaled admission; ${receipts.has(verifier.key)?'completed receipt recorded':'outcome uncertain, no completed receipt'}. Not every available field was sent.`
          : 'No model admission recorded. No completed model inspection is claimed.','provenance'),
        field('Original candidate checkpoint (JSON)',c),
      ];
      for(const r of relevant) {
        const {capture,file}=captures.get(r.key);
        fields.push(
          field(`${r.kind} exact journaled request (JSON)`,r.body,'metadata'),
          field(`${r.kind} admission and completion receipt (JSON)`,{admission:r.admission,completion:receipts.get(r.key)??null},'provenance'),
          field(`${r.kind} original provider response (JSON)`,capture,'metadata'),
          field(`${r.kind} response archive status`,capture ? `Retained: ${file}` : `Unavailable: ${file}. No evidence reconstructed.`,'provenance'),
        );
      }
      rows.push({id:`${batchId}:${rows.length}`,artistName:target.artist,profileId:pid,
        candidateUrl:c?.url??null,verifiedUrl:null,status:c?.status??'no_saved_candidate',
        score:c?.recordedAnswer?.sameIdentityProbability??null,verdict:c?.recordedAnswer?.verdict??null,
        comparisonType:null,fields});
    }
  }
  if(seen.size!==targets.size) throw Error('Checkpoint omits approved artists.');
  const count=status=>rows.filter(r=>r.status===status).length;
  const metric=(label,value)=>({label,value:String(value)});
  const batch={
    id:batchId,title:`Saved alternatives · ${targets.size} artists`,source:'diagnostic',
    // With no dispatch, label the source file time explicitly, not as approval time.
    createdAt:admissions[0]?.at ?? (await fs.stat(path.join(directory,summaryText?'summary.json':'outcomes.jsonl'))).mtime.toISOString(),
    status:result.status ?? 'interrupted_checkpoint',
    artistCount:targets.size,candidateCount:rows.filter(r=>r.candidateUrl).length,rowCount:rows.length,
    verifiedCount:0,reviewCount:count('positive_review_suggestion'),notInspectedCount:count('uninspected'),
    metadataFailedCount:0,noCandidateCount:count('no_saved_candidate'),
    reservedUsd:budget.reservedCents/100,reportedUsd:budget.reportedCostUsd??null,
    explanation:'Saved alternatives, review only. Importing and viewing never calls providers, discovers links or accepts links. Unavailable, unsupported, uninspected and no saved candidate are distinct; none proves an account is missing. One parent allowance covers every candidate and both providers. Reported model cost is separate from conservative metadata estimates and reservations.',
    metrics:[
      metric('Parent budget identity',budget.budgetId),metric('Parent approved ceiling',money(auth.maxSpendCents)),
      metric('Parent reserved total',money(budget.reservedCents)),
      metric('Unused parent allowance (not released)',money(auth.maxSpendCents-budget.reservedCents)),
      metric('Reported model cost (USD)',budget.reportedCostUsd??'Not recorded'),
      metric('Conservative metadata cost estimate (USD)',budget.estimatedCostUsd??'Not recorded'),
      metric('Admitted calls',budget.admitted??'Not recorded'),metric('Returned calls',budget.returned??'Not recorded'),
      metric('Journaled reservations (cents)',requests.size*2),
      metric('Spending observation',summaryText ? 'Final saved parent snapshot, not an invoice'
        : 'Last durable parent snapshot; journal may be newer. Unjournaled reservations are unknown. No resume authorized.'),
      metric('Run date source',admissions.length ? 'First journal event' : 'Source checkpoint file modification time; no dispatch date recorded'),
      metric('Alternatives approved',scope.inspectSavedAlternatives),
      ...states.map(s=>metric(s.replaceAll('_',' '),count(s))),
      metric('no saved candidate',count('no_saved_candidate')),
      metric('Budget exhausted',result.budgetExhausted??'Not recorded'),
      metric('Stop reason',result.stopReason??(summaryText?'None recorded':'No final summary; last durable checkpoint only')),
    ],
    details:[
      field('Original parent spending checkpoint (JSON)',budget,'provenance'),
      field('Original final summary or durable checkpoint (JSON)',result,'decision'),
      field('Frozen approval scope and hash (JSON)',frozen,'provenance'),
      field('Original admission journal (JSON)',admissions,'provenance'),
      field('Imported file provenance and SHA256 (JSON)',provenance,'provenance'),
    ],
  };
  if(!Number.isFinite(Date.parse(batch.createdAt))) throw Error('No recorded run timestamp; refusing to invent one.');
  return {batch,rows};
}

async function main() {
  const [input,output,...extra]=process.argv.slice(2);
  if(!input || !output || extra.length) throw Error('Usage: node scripts/src/import-saved-alternatives.mjs run-directory new-output-directory');
  const document=await buildSavedAlternativesDocument(path.resolve(input));
  const bytes=JSON.stringify(document);
  if(Buffer.byteLength(bytes)>40*1024*1024) throw Error('UI archive exceeds 40 MiB limit.');
  // A new output directory avoids overwriting either evidence or previous imports.
  await fs.mkdir(output,{recursive:false});
  await fs.writeFile(path.join(output,`${document.batch.id}.json`),bytes,{flag:'wx'});
  await fs.writeFile(path.join(output,'index.json'),JSON.stringify({batches:[document.batch],warnings:[]}),{flag:'wx'});
  console.log(`Prepared ${document.rows.length} read-only rows. Publish with the existing artist archive publisher.`);
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) await main();
