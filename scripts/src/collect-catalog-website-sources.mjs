// Local archive adapter CLI. Public profile acquisition requires an extra flag.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectCatalogWebsiteDeclarations,assertSourceInputsBlind} from './catalog-website-source.mjs';

async function json(file){
  if((await fs.stat(file)).size>5_000_000)throw new Error('Input file exceeds 5 MB.');
  return JSON.parse(await fs.readFile(file,'utf8'));
}
export async function collectFromManifest(manifest,{allowPublicFetch=false}={}){
  assertSourceInputsBlind(manifest);
  if(!manifest||!Array.isArray(manifest.archiveFiles??[])
    ||!Array.isArray(manifest.archives??[])
    ||(manifest.archiveFiles??[]).length+(manifest.archives??[]).length>1000)
    throw new Error('Bounded archiveFiles/archives arrays required.');
  let inputBytes=Buffer.byteLength(JSON.stringify(manifest));
  const archives=[...(manifest.archives??[])];
  for(const file of manifest.archiveFiles??[]){
    inputBytes+=(await fs.stat(file)).size;
    if(inputBytes>20_000_000)throw new Error('Archive inputs exceed 20 MB total limit.');
    archives.push(await json(file));
  }
  const now=typeof manifest.now==='string'?Date.parse(manifest.now):manifest.now;
  if(manifest.publicFetch?.enabled&&!allowPublicFetch)
    throw new Error('Public fetching also requires --allow-public-fetch.');
  return collectCatalogWebsiteDeclarations({
    player:manifest.player,archives,pages:manifest.pages??[],now,
    maxEvidenceAgeMs:manifest.maxEvidenceAgeMs,
    publicFetch:allowPublicFetch?{...manifest.publicFetch,enabled:true}:undefined,
  });
}
async function main(){
  const args=process.argv.slice(2);
  if(args.some((arg,i)=>!['--input','--out','--allow-public-fetch'].includes(arg)
    &&!['--input','--out'].includes(args[i-1])))throw new Error('Unsupported argument.');
  const input=args[args.indexOf('--input')+1],output=args[args.indexOf('--out')+1];
  if(!args.includes('--input')||!args.includes('--out')||!input||!output)
    throw new Error('Usage: node scripts/src/collect-catalog-website-sources.mjs --input manifest.json --out generated-artifacts/source-trust/report.json [--allow-public-fetch]');
  const root=path.resolve('generated-artifacts'),destination=path.resolve(output);
  if(!destination.startsWith(`${root}${path.sep}`))throw new Error('Output must be under generated-artifacts/.');
  const report=await collectFromManifest(await json(input),{
    allowPublicFetch:args.includes('--allow-public-fetch')});
  await fs.mkdir(path.dirname(destination),{recursive:true});
  await fs.writeFile(destination,JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify({output,declarations:report.declarations.length,
    unresolved:report.unresolved.length,paidCalls:0,databaseWrites:0,offlineOnly:true}));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
