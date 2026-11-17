// Local saved-results audit and future recovery preparation; never starts paid work.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {coverageRecoveryPlan} from './youtube-coverage-recovery.mjs';

const [sourceRoot,outputRoot,...extra]=process.argv.slice(2);
assert.ok(sourceRoot&&outputRoot&&!extra.length,
  'Usage: prepare-youtube-coverage-recovery <saved-run-directory> <new-output-directory>');
const generated=path.resolve('generated-artifacts')+path.sep;
for(const root of [sourceRoot,outputRoot])assert.ok(path.resolve(root).startsWith(generated));
const records=JSON.parse(await fs.readFile(path.join(sourceRoot,'results.json'),'utf8'));
const plan=coverageRecoveryPlan(records);
await fs.mkdir(outputRoot,{recursive:false});
await fs.writeFile(path.join(outputRoot,'plan.json'),JSON.stringify(plan,null,2),{flag:'wx'});
const columns=['artist','tier','profile_id','cm_artist','previous_outcome',
  'unused_saved_channels','unused_saved_videos','fallback_was_suppressed','new_searches_proposed'];
const cell=v=>'"'+String(v??'').replace(/^[=+\-@\t\r\n]/u,"'$&").replaceAll('"','""')+'"';
const rows=plan.recovery.map(r=>[r.artist,r.tier,r.profileId,r.cmArtist,r.previousOutcome,
  r.savedDirectCandidates.length,r.savedVideoLeads.length,r.fallbackSuppressedByDirectSelection,r.newSearches.length]);
await fs.writeFile(path.join(outputRoot,'coverage-recovery.csv'),
  '\ufeff'+[columns,...rows].map(row=>row.map(cell).join(',')).join('\r\n'),{flag:'wx'});
console.log(JSON.stringify(plan.summary,null,2));
