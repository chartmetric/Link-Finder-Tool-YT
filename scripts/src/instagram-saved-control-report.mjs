// Read-only offline diagnostics. Do not import the paid rerun entry point.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {instagramProfileUrl} from './musician-instagram-matching.mjs';

const compare=(a,b)=>a<b?-1:a>b?1:0;
const sorted=values=>[...new Set(values)].sort(compare);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const pair=(targetId,accountUrl)=>JSON.stringify([targetId,accountUrl]);
const note='Cross-artist synthetic challenges only, not independently source-reviewed ownership labels. '
  +'Distinct saved URLs do not establish distinct owners, independent artists or statistical independence. '
  +'Repeated runs and repeated observations do not add independent coverage. Gate passes are observations, '
  +'not false positives. Ownership labels remain unassigned and accuracy is unscored; '
  +'the separately approved benchmark policy is unchanged.';

function targetId(value,where){
  if(!['string','number'].includes(typeof value)||!String(value).trim()
    ||(typeof value==='number'&&!Number.isSafeInteger(value)))
    throw Error(`${where}: missing or invalid target profile ID`);
  return String(value).trim();
}
function accountUrl(value,where){
  const url=instagramProfileUrl(value);
  if(!url)throw Error(`${where}: invalid saved Instagram profile URL`);
  return url;
}
function counts(rows){
  const accounts=sorted(rows.map(r=>r.accountUrl));
  return {
    comparisons:rows.length,
    distinctTargets:new Set(rows.map(r=>r.targetId)).size,
    distinctControlAccounts:accounts.length,
    distinctPairs:new Set(rows.map(r=>pair(r.targetId,r.accountUrl))).size,
    reusedAccountComparisons:rows.length-accounts.length,
    repeatedPairComparisons:rows.length-new Set(rows.map(r=>pair(r.targetId,r.accountUrl))).size,
  };
}
const intersection=(a,b)=>sorted(a.filter(value=>b.includes(value)));

/** Pure report builder; no archive mutations and no model/ownership grading. */
export function compareSavedControls(inputs){
  if(!Array.isArray(inputs)||!inputs.length)throw Error('Provide at least one saved run.');
  const ids=new Set();
  const runs=inputs.map(({runId,scope,summary=null,source=null})=>{
    if(typeof runId!=='string'||!runId.trim()||ids.has(runId))throw Error('Run IDs must be unique non-empty strings.');
    ids.add(runId);
    if(!Array.isArray(scope?.cases))throw Error(`${runId}: prepared scope must contain cases`);
    if(summary!==null&&!Array.isArray(summary?.results))throw Error(`${runId}: summary must contain results`);
    const targets=[],planned=[],evaluated=[],controlStatuses=Object.create(null);
    let unassignedComparisons=0;
    scope.cases.forEach((c,i)=>{
      const where=`${runId} case ${i}`;
      const target=targetId(c?.artist?.profile_id,where);
      targets.push(target);
      if(c.control==null){unassignedComparisons++;return;}
      planned.push({targetId:target,accountUrl:accountUrl(c.control.profile?.url,where)});
    });
    const plannedPairs=new Set(planned.map(r=>pair(r.targetId,r.accountUrl)));
    (summary?.results??[]).forEach((r,i)=>{
      if(r?.variant!=='control')return;
      if(typeof r.status!=='string'||!r.status)throw Error(`${runId} result ${i}: missing control status`);
      controlStatuses[r.status]=(controlStatuses[r.status]??0)+1;
      if(r.status!=='evaluated')return;
      const row={targetId:targetId(r.profileId,`${runId} result ${i}`),
        accountUrl:accountUrl(r.instagramUrl,`${runId} result ${i}`),
        gatePassed:r.gatePassed===true};
      evaluated.push({...row,plannedPair:plannedPairs.has(pair(row.targetId,row.accountUrl))});
    });
    const plannedAccounts=sorted(planned.map(r=>r.accountUrl));
    const evaluatedAccounts=sorted(evaluated.map(r=>r.accountUrl));
    return {
      runId,source,summaryState:summary===null?'missing_not_evidence_of_no_calls':'saved',
      targetArtists:new Set(targets).size,scopeCaseOccurrences:scope.cases.length,
      unassignedComparisons,
      unassignedTargets:sorted(targets.filter(t=>!planned.some(r=>r.targetId===t))),
      planned:{...counts(planned),diversityStatus:planned.length===scope.cases.length
        &&plannedAccounts.length===scope.cases.length&&scope.cases.length>0
        ?'distinct_account_per_target':'insufficient_control_diversity'},
      evaluated:{...counts(evaluated),gatePassObservations:evaluated.filter(r=>r.gatePassed).length,
        unplannedPairObservations:evaluated.filter(r=>!r.plannedPair).length,
        diversityStatus:!evaluated.length?'not_evaluated'
          :evaluated.every(r=>r.plannedPair)&&evaluatedAccounts.length===scope.cases.length
            &&new Set(evaluated.map(r=>r.targetId)).size===scope.cases.length
            ?'distinct_account_per_target':'insufficient_control_diversity'},
      controlStatuses,targets:sorted(targets),plannedRows:planned,evaluatedRows:evaluated,
    };
  });
  const overlaps=[];
  for(let i=0;i<runs.length;i++)for(let j=i+1;j<runs.length;j++){
    const a=runs[i],b=runs[j],entry={runA:a.runId,runB:b.runId};
    for(const phase of ['planned','evaluated']){
      const ar=a[`${phase}Rows`],br=b[`${phase}Rows`];
      const accounts=intersection(ar.map(r=>r.accountUrl),br.map(r=>r.accountUrl));
      const pairs=intersection(ar.map(r=>pair(r.targetId,r.accountUrl)),br.map(r=>pair(r.targetId,r.accountUrl)));
      entry[phase]={distinctControlAccounts:accounts.length,accountUrls:accounts,
        distinctTargets:intersection(ar.map(r=>r.targetId),br.map(r=>r.targetId)).length,
        distinctPairs:pairs.length,pairs:pairs.map(p=>JSON.parse(p))};
    }
    overlaps.push(entry);
  }
  const combined={runs: runs.length,distinctScopeTargets:new Set(runs.flatMap(r=>r.targets)).size,
    runsMissingSummary:runs.filter(r=>r.summaryState!=='saved').map(r=>r.runId)};
  for(const phase of ['planned','evaluated']){
    const rows=runs.flatMap(r=>r[`${phase}Rows`]);
    const accounts=sorted(rows.map(r=>r.accountUrl)).map(url=>{
      const members=runs.filter(r=>r[`${phase}Rows`].some(row=>row.accountUrl===url));
      const observations=rows.filter(r=>r.accountUrl===url);
      return {accountUrl:url,runIds:members.map(r=>r.runId),comparisons:observations.length,
        distinctTargets:new Set(observations.map(r=>r.targetId)).size,
        distinctPairs:new Set(observations.map(r=>pair(r.targetId,r.accountUrl))).size};
    });
    combined[phase]={...counts(rows),sumPerRunDistinctTargets:runs.reduce((n,r)=>n+r[phase].distinctTargets,0),
      sumPerRunDistinctControlAccounts:runs.reduce((n,r)=>n+r[phase].distinctControlAccounts,0),
      sumPerRunDistinctPairs:runs.reduce((n,r)=>n+r[phase].distinctPairs,0),
      controlAccountsSharedAcrossRuns:accounts.filter(a=>a.runIds.length>1).length,accounts,
      pairs:sorted(rows.map(r=>pair(r.targetId,r.accountUrl))).map(p=>{
        const [target,account]=JSON.parse(p);
        return {targetId:target,accountUrl:account,
          runIds:runs.filter(r=>r[`${phase}Rows`].some(row=>pair(row.targetId,row.accountUrl)===p)).map(r=>r.runId),
          comparisons:rows.filter(row=>pair(row.targetId,row.accountUrl)===p).length};
      })};
  }
  return {schemaVersion:1,kind:'cross_artist_synthetic_challenge_overlap',offline:true,
    ownershipLabelsAssigned:0,independentlySourceReviewedNegativeLabels:0,
    accuracyScored:false,calibratedFalsePositiveRate:null,note,
    countingRules:{
      target:'Trimmed catalog profile_id, not artist name, Chartmetric ID or control-source profile ID.',
      account:'Canonical Instagram profile URL; casing, www/mobile aliases, query and fragment do not add accounts.',
      pair:'Target catalog profile ID plus normalized control-account URL.',
      planned:'Every non-null saved case control; duplicate case rows remain occurrences.',
      evaluated:'Only summary results with variant=control and status=evaluated; candidate, held and unresolved rows excluded.',
      combined:'Set unions, not sums of per-run distinct counts. Occurrences and gate passes are not independent samples.',
      missingSummary:'No evaluated observations available; this does not prove no provider calls occurred.',
      unmatched:'Evaluated pairs absent from the prepared plan remain in evaluated totals and are flagged, never substituted.',
    },
    runs,combined,overlaps};
}

/** Only the two named local JSON files are read. Missing summary is explicit. */
export async function loadSavedControlReport(directories){
  const seen=new Set(),inputs=[];
  for(const directory of directories){
    const real=await fs.realpath(directory);
    if(seen.has(real))throw Error(`Duplicate saved run directory: ${directory}`);
    seen.add(real);
    const scopeFile=path.join(real,'prepared-scope.json'),summaryFile=path.join(real,'summary.json');
    const scopeBytes=await fs.readFile(scopeFile);
    let summaryBytes=null;
    try{summaryBytes=await fs.readFile(summaryFile);}catch(error){if(error.code!=='ENOENT')throw error;}
    inputs.push({runId:real,scope:JSON.parse(scopeBytes),summary:summaryBytes===null?null:JSON.parse(summaryBytes),
      source:{directory:real,preparedScopeSha256:digest(scopeBytes),
        summarySha256:summaryBytes===null?null:digest(summaryBytes)}});
  }
  return compareSavedControls(inputs);
}

const cell=value=>String(value).replaceAll('|','\\|').replace(/[\r\n]/g,' ');
export function renderSavedControlMarkdown(report){
  const lines=['# Saved comparison control-account overlap','',report.note,'',
    'Planned assignments and saved evaluated observations are counted separately. Missing summaries do not prove no calls occurred.',
    'Evaluated totals include and flag any pair not found in its saved plan. Candidate results are excluded.',
    'Combined counts are set unions; summed counts and repeated runs are not independent coverage.','',
    '| Run | Phase | Comparisons | Distinct targets | Distinct accounts | Distinct pairs |',
    '| --- | --- | ---: | ---: | ---: | ---: |'];
  for(const run of report.runs)for(const phase of ['planned','evaluated']){
    const c=run[phase];
    lines.push(`| ${cell(run.runId)} | ${phase} | ${c.comparisons} | ${c.distinctTargets} | ${c.distinctControlAccounts} | ${c.distinctPairs} |`);
  }
  for(const phase of ['planned','evaluated']){
    const c=report.combined[phase];
    lines.push(`| **Combined union** | ${phase} | ${c.comparisons} | ${c.distinctTargets} | ${c.distinctControlAccounts} | ${c.distinctPairs} |`);
  }
  lines.push('','## Per-run availability and observations','');
  for(const run of report.runs)lines.push(`- ${cell(run.runId)}: ${run.summaryState}; ${run.targetArtists} scope targets; `
    +`${run.unassignedComparisons} unassigned case occurrences; ${run.unassignedTargets.length} targets without a planned control; `
    +`planned ${run.planned.diversityStatus}; evaluated ${run.evaluated.diversityStatus}; `
    +`${run.evaluated.gatePassObservations} gate-pass observations (not false positives); `
    +`${run.evaluated.unplannedPairObservations} unplanned evaluated pair observations. `
    +`Saved control statuses: ${cell(JSON.stringify(run.controlStatuses))}.`);
  lines.push('','## Pairwise run overlap','');
  if(!report.overlaps.length)lines.push('Only one run supplied; cross-run overlap is not established.');
  for(const overlap of report.overlaps){
    lines.push(`### ${cell(overlap.runA)} / ${cell(overlap.runB)}`,'');
    for(const phase of ['planned','evaluated']){
      const c=overlap[phase];
      lines.push(`- ${phase}: ${c.distinctControlAccounts} shared accounts; ${c.distinctTargets} shared targets; ${c.distinctPairs} shared pairs.`,
        ...c.accountUrls.map(url=>`  - ${url}`));
    }
    lines.push('');
  }
  lines.push('## Combined account membership','');
  for(const phase of ['planned','evaluated']){
    const c=report.combined[phase];
    lines.push(`### ${phase}`,'',
      `Per-run distinct-target sum: ${c.sumPerRunDistinctTargets}; combined union: ${c.distinctTargets}.`,
      `Per-run distinct-account sum: ${c.sumPerRunDistinctControlAccounts}; combined union: ${c.distinctControlAccounts}.`,
      `Per-run distinct-pair sum: ${c.sumPerRunDistinctPairs}; combined union: ${c.distinctPairs}.`,'');
    for(const a of c.accounts)lines.push(`- ${a.accountUrl}: ${a.comparisons} observations, ${a.distinctTargets} targets, `
      +`${a.distinctPairs} pairs; runs: ${a.runIds.map(cell).join(', ')}.`);
    lines.push('');
  }
  lines.push('## Source fingerprints','');
  for(const run of report.runs)if(run.source)lines.push(`- ${cell(run.runId)}: prepared-scope SHA-256 `
    +`${run.source.preparedScopeSha256}; summary SHA-256 ${run.source.summarySha256??'missing'}.`);
  return lines.join('\n')+'\n';
}

export async function savedControlReportCli(args){
  const directories=[];let output=null;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--output'){
      if(output||!args[i+1]||args[i+1].startsWith('--'))throw Error('Supply one new --output directory.');
      output=args[++i];
    }else if(args[i].startsWith('--'))throw Error(`Unknown option: ${args[i]}`);
    else directories.push(args[i]);
  }
  const report=await loadSavedControlReport(directories);
  if(output){
    // A new directory outside every source archive prevents overwriting frozen files.
    const parent=await fs.realpath(path.dirname(path.resolve(output)));
    const destination=path.join(parent,path.basename(path.resolve(output)));
    for(const run of report.runs){
      const relative=path.relative(run.source.directory,destination);
      if(!relative||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative)))
        throw Error('Report output must be outside every frozen source directory.');
    }
    await fs.mkdir(destination,{recursive:false});
    await fs.writeFile(path.join(destination,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    await fs.writeFile(path.join(destination,'report.md'),renderSavedControlMarkdown(report),{flag:'wx'});
  }
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await savedControlReportCli(process.argv.slice(2)),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
