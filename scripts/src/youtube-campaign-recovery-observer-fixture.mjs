// Bundles the real observer with fixture-only service boundaries. It cannot
// connect to PostgreSQL, App Storage or the catalog, even if credentials exist.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const require=createRequire(new URL('../../artifacts/api-server/package.json',import.meta.url));
const {build}=require('esbuild');
export async function observeRecoveredFixture({directory,root,state}){
  const workspace=directory+'/observer-workspace',archive=directory+'/mirrored',progress=directory+'/published.json';
  await fs.mkdir(workspace+'/generated-artifacts',{recursive:true});
  await fs.symlink(path.resolve(root),workspace+'/generated-artifacts/'+state.campaign.id,'dir');
  const modules={
    '../lib/artist-campaign-progress':`export async function workspaceRoot(){return ${JSON.stringify(workspace)}}`,
    '../lib/logger':`export const logger={info(){},error(value){console.error(value)}}`,
    '../lib/youtube-artist-progress':`import fs from 'node:fs/promises';
      export async function publishYoutubeCampaignProgress(value){
        await fs.writeFile(${JSON.stringify(progress)},JSON.stringify(value));
      }`,
    '../lib/artist-result-storage':`import fs from 'node:fs/promises';import path from 'node:path';
      export function artistExportObject(name){return {async save(bytes){
        const file=path.join(${JSON.stringify(archive)},name);
        await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes,{flag:'wx'});
      }}}`,
    '@workspace/db':`const state=${JSON.stringify(state)};
      state.campaign.updated_at=new Date(state.campaign.updated_at);
      async function query(sql){
        if(sql.includes('SELECT * FROM youtube_link_campaigns'))return {rows:[state.campaign]};
        if(sql.includes('FROM youtube_link_campaign_artists'))
          return {rows:state.artists.filter(a=>a.status!=='queued')};
        if(sql.includes('coalesce(sum(reserved_cents),0)'))
          return {rows:[{reserved:String(state.admissions.reduce((n,a)=>n+Number(a.reserved_cents),0))}]};
        if(sql.includes('SELECT operation_key,receipt_sha256'))
          return {rows:state.admissions.filter(a=>a.status==='returned')};
        if(/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql))return {rows:[]};
        throw Error('Observer tried an unexpected database operation');
      }
      export const pool={async connect(){return {query,release(){}}},async end(){}};`,
  };
  const output=directory+'/isolated-observer.mjs';
  await build({entryPoints:['artifacts/api-server/src/cli/publish-youtube-campaign-progress.ts'],
    bundle:true,platform:'node',format:'esm',outfile:output,logLevel:'silent',
    plugins:[{name:'fixture-service-boundaries',setup(b){
      b.onResolve({filter:/^(?:@workspace\/db|\.\.\/lib\/(?:artist-campaign-progress|logger|youtube-artist-progress|artist-result-storage))$/},
        args=>({path:args.path,namespace:'fixture-services'}));
      b.onLoad({filter:/.*/,namespace:'fixture-services'},args=>{
        if(!(args.path in modules))throw Error('Unknown isolated observer import');
        return {contents:modules[args.path],loader:'js'};
      });
    }}]});
  // No environment credentials are inherited by this read-only fixture process.
  await promisify(execFile)(process.execPath,[output,'--publish','--run-id='+state.campaign.id],{env:{},timeout:15000});
  return {progress:JSON.parse(await fs.readFile(progress,'utf8')),archive};
}
