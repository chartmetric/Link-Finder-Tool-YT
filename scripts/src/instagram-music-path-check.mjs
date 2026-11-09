// Narrow public-page diagnostic. No provider credentials, searches or claims.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {safeMusicFetch} from './safe-music-fetch.mjs';
import {parsePublicMusicPage,resolveMusicEvidence} from './public-music-links.mjs';
import {instagramProfileUrl} from './musician-instagram-matching.mjs';

const source='generated-artifacts/instagram-verification-benchmark-2026-11-06';
const initialOutput='generated-artifacts/instagram-music-path-check-2026-11-09';
const followup=process.argv.includes('--album-schema-followup');
const output=followup?`${initialOutput}-album-schema`:initialOutput;
const ids=followup?['208216','35092']:['208216','216490','35092'];
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const save=(file,x)=>fs.writeFile(file,JSON.stringify(x,null,2),{flag:'wx'});
const hash=x=>createHash('sha256').update(x).digest('hex');
const sources=[],prepared=[];
const cachedPages=new Map();
if(followup) {
  const file=`${initialOutput}/summary.json`,text=await fs.readFile(file,'utf8'),previous=JSON.parse(text);
  assert.equal(previous.admitted,7);
  sources.push({file,sha256:hash(text)});
  // Reuse the already captured Linkfire page. Re-fetch only the two album
  // embeds using the repaired field parser; don't replay the first run.
  for(const result of previous.results) for(const page of result.evidence.pages) {
    if(page.sourceUrl.startsWith('https://theformat.lnk.to/')) cachedPages.set(page.sourceUrl,page);
  }
}
const names=await fs.readdir(`${source}/responses`);
for(const id of ids) {
  const file=`${source}/${id}-metadata.json`,text=await fs.readFile(file,'utf8'),a=JSON.parse(text);
  const rawFile=`${source}/responses/${names.find(n=>n.startsWith(`${id}-scrapecreators_candidate-`))}`;
  const rawText=await fs.readFile(rawFile,'utf8'),packet=JSON.parse(rawText);
  assert.equal(packet.status,200);
  const user=packet.data.data?.user??packet.data.user;
  assert.equal(instagramProfileUrl(`https://www.instagram.com/${user.username}/`),a.candidateMetadata.url);
  a.candidateMetadata.directExternalUrls=[user.external_url,...(user.bio_links??[]).map(b=>b.url)].filter(Boolean);
  sources.push({file,sha256:hash(text)},{file:rawFile,sha256:hash(rawText)});
  prepared.push(a);
}
if(!process.argv.includes('--check-public-pages')) {
  console.log(JSON.stringify({artists:prepared.map(a=>a.artist),maxPublicRequests:12,
    maxNewRequests:followup?2:12,maxRequestsPerArtist:4,paidRequests:0,claims:0,databaseWrites:0}));process.exit(0);
}
await fs.mkdir(output,{recursive:false}); // Never replay an existing admitted run.
await save(`${output}/scope.json`,{authorization:'User approved focusing on missing music evidence paths.',
  profileIds:ids,sources,maxRequests:followup?2:12,maxPerArtist:followup?1:4,automaticRetries:0,paidRequests:0,
  priorPublicRequests:followup?7:0,additionalSchemaInspectionRequests:followup?2:0,
  noDiscovery:true,noMetadataApi:true,noModelCalls:true,noClaims:true,noDatabaseWrites:true,
  sameArtistOwnershipStillRequiresVerification:true});
const journal=await fs.open(`${output}/admissions.jsonl`,'wx');
const append=async row=>{await journal.write(JSON.stringify({...row,at:new Date().toISOString()})+'\n');await journal.sync();};
let admitted=0;const results=[];
try {
  for(const a of prepared) {
    let perArtist=0;
    const evidence=await resolveMusicEvidence({candidate:a.candidateMetadata,catalog:a.reference,maxPages:4,
      readPage:async url=>{
        if(cachedPages.has(url)) return structuredClone(cachedPages.get(url));
        assert.ok(admitted<(followup?2:12)&&perArtist<(followup?1:4));
        const key=`${a.profile_id}-${++perArtist}`;
        await append({phase:'admitted',key,url,profileId:a.profile_id});
        admitted++;
        try {
          const response=await safeMusicFetch(url,{signal:AbortSignal.timeout(20000)});
          const chunks=[];let length=0;
          if(response.body) for await(const chunk of response.body) {
            length+=chunk.length;
            if(length>2000000) throw Error('Public music page exceeds bounded body limit');
            chunks.push(chunk);
          }
          const parsed=parsePublicMusicPage(url,Buffer.concat(chunks).toString('utf8'),
            {status:response.status,location:response.headers.get('location')});
          // Selected evidence only. Never archive raw embedded sessions or HTML.
          await save(`${output}/${key}.json`,{url,httpStatus:response.status,evidence:parsed});
          await append({phase:'returned',key,httpStatus:response.status});
          return parsed;
        }catch(error) {
          await append({phase:'failed_no_retry',key,reason:error.message});
          throw error;
        }
      }});
    const row={profileId:a.profile_id,artist:a.artist,catalog:a.reference,evidence,
      artistOwnershipVerified:false,productionApproved:false};
    results.push(row);
    await save(`${output}/${a.profile_id}-result.json`,row);
    console.log(JSON.stringify({artist:a.artist,status:evidence.status,pages:evidence.pages.length,
      attempted:evidence.attempts.length,reason:evidence.reason}));
  }
}finally {
  await journal.close();
  await save(`${output}/summary.json`,{completed:results.length===ids.length,results,admitted,
    paidRequests:0,newSearches:0,newMetadataApiCalls:0,newModelCalls:0,claims:0,databaseWrites:0,
    reportedPaidCostUsd:0,remainingConservativelyReservedPilotUsd:6.83,
    caveat:'Exact music identity is technical evidence, not artist ownership or import approval.'});
}
