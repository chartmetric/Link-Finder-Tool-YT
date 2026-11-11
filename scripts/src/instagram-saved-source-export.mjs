// A local, read-only export receipt binds the musician model, identities and bytes.
// It is not an ownership attestation and cannot authorize provider spending.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {metadataQueries,select,validateScope} from './instagram-artist-metadata-overlay.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
const files={catalogProfiles:'frozen-profiles.json',accounts:'frozen-accounts.json',chartmetric:'frozen-country.json'};
export async function readSavedDiscovery(dir) {
  const names=(await fs.readdir(dir)).filter(f=>/^discovery-\d+\.json$/.test(f)).sort();
  if(!names.length)throw Error('Missing saved discovery exports.');
  const sources={},rows=[];
  for(const name of names){
    const text=await fs.readFile(path.join(dir,name),'utf8'),data=JSON.parse(text);
    if(!Array.isArray(data))throw Error('Invalid saved discovery export.');
    sources[name]=hash(text);rows.push(...data);
  }
  const manifest={artists:rows.map(r=>({profile_id:String(r.profile_id),cm_artist:String(r.cm_artist)}))};
  validateScope(manifest,500);
  if(new Set(manifest.artists.map(a=>a.cm_artist)).size!==rows.length)throw Error('Duplicate saved Chartmetric identity.');
  return {rows,manifest,sources};
}
export function savedSourceQueries(manifest) {
  const queries=metadataQueries(manifest,500);
  return Object.fromEntries(Object.keys(files).map(k=>[k,queries[k]]));
}
function validateRows(manifest,data) {
  const scope=new Map(manifest.artists.map(a=>[String(a.profile_id),String(a.cm_artist)]));
  const cms=new Set(scope.values());
  for(const key of Object.keys(files))if(!Array.isArray(data[key]))throw Error('Missing musician source rows.');
  const seen=new Set();
  for(const p of data.catalogProfiles){
    if(!scope.has(p.profile_id)||scope.get(p.profile_id)!==p.cm_artist||seen.has(p.profile_id)
      ||typeof p.name!=='string'||!p.name.trim())throw Error('Catalog profile/Chartmetric identity mismatch.');
    seen.add(p.profile_id);
  }
  if(seen.size!==scope.size)throw Error('Incomplete musician profile export; accounts cannot establish identity.');
  const links=new Set();
  for(const a of data.accounts){
    const key=`${a.profile_id}:${a.account_id}`;
    if(!scope.has(a.profile_id)||scope.get(a.profile_id)!==a.cm_artist||links.has(key)
      ||!/^\d+$/.test(a.account_id)||typeof a.platform!=='string'||!a.platform||a.platform==='instagram'
      ||(a.account_url!==null&&typeof a.account_url!=='string')
      ||a.disconnected_at||a.is_active===0)
      throw Error('Account source identity mismatch or invalid musician account binding.');
    links.add(key);
  }
  const countries=new Set();
  for(const c of data.chartmetric){
    if(!cms.has(c.cm_artist)||countries.has(c.cm_artist))throw Error('Chartmetric source identity mismatch.');
    countries.add(c.cm_artist);
  }
}
export async function exportSavedBatchSources(dir,{query=select,now=()=>new Date().toISOString()}={}) {
  const {manifest,sources}=await readSavedDiscovery(dir),queries=savedSourceQueries(manifest),data={};
  // Do not replace a previously frozen export, including an interrupted export.
  for(const name of [...Object.values(files),'source-export.json']){
    try{await fs.access(path.join(dir,name));}catch(e){if(e.code==='ENOENT')continue;throw e;}
    throw Error('Source export already exists; refusing overwrite.');
  }
  for(const [key,sql] of Object.entries(queries))data[key]=await query(sql);
  validateRows(manifest,data);
  const hashes={...sources};
  for(const [key,name] of Object.entries(files)){
    const text=JSON.stringify(data[key],null,2)+'\n';
    await fs.writeFile(path.join(dir,name),text,{flag:'wx'});hashes[name]=hash(text);
  }
  const receipt={version:1,sourceModel:'new_vertical.profile:cm_artist',collectedAt:now(),
    scope:manifest.artists,queries,files:hashes,ownershipConfirmed:false};
  const text=JSON.stringify(receipt,null,2)+'\n';
  await fs.writeFile(path.join(dir,'source-export.json'),text,{flag:'wx'});
  return {receipt,sourceExportSha256:hash(text),paidProviderCalls:0,databaseWrites:0};
}
export async function readVerifiedSavedSources(dir,discovery) {
  const text=await fs.readFile(path.join(dir,'source-export.json'),'utf8'),receipt=JSON.parse(text);
  if(receipt.version!==1||receipt.sourceModel!=='new_vertical.profile:cm_artist'
    ||receipt.ownershipConfirmed!==false
    ||JSON.stringify(receipt.scope)!==JSON.stringify(discovery.manifest.artists)
    ||JSON.stringify(receipt.queries)!==JSON.stringify(savedSourceQueries(discovery.manifest)))
    throw Error('Untrusted musician source export provenance; re-export from the authoritative catalog.');
  const expected=[...Object.keys(discovery.sources),...Object.values(files)].sort();
  if(!receipt.files||JSON.stringify(Object.keys(receipt.files).sort())!==JSON.stringify(expected))
    throw Error('Source export file set changed.');
  for(const [name,sha] of Object.entries(discovery.sources)){
    if(receipt.files[name]!==sha)throw Error('Saved discovery source hash changed.');
  }
  const data={};
  for(const [key,name] of Object.entries(files)){
    const raw=await fs.readFile(path.join(dir,name),'utf8');
    if(hash(raw)!==receipt.files[name])throw Error('Frozen musician source hash changed.');
    data[key]=JSON.parse(raw);
  }
  validateRows(discovery.manifest,data);
  return {...data,sourceExportSha256:hash(text)};
}
