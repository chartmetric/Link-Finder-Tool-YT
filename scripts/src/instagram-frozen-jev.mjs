// Reusable bounded transport for frozen-input experiments, never imports links.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {answersFrom} from './instagram-jev-label-ablation.mjs';

export function frozenJevTransport({responseDir,apiKey,fetchImpl=fetch}) {
  if(!apiKey) throw Error('Missing OpenRouter credential.');
  return {live:true,inputBytes:({payload})=>Buffer.byteLength(JSON.stringify(payload.body)),
    dispatch:async({kind,payload,key,signal})=>{
      if(kind!=='jev') throw Error('Frozen verifier transport cannot dispatch another provider.');
      const body=JSON.stringify(payload.body);
      if(Buffer.byteLength(body)>6000||createHash('sha256').update(body).digest('hex')!==payload.inputSha256) {
        throw Error('Changed or oversized frozen request; no dispatch.');
      }
      const r=await fetchImpl('https://openrouter.ai/api/alpha/decisions',{method:'POST',redirect:'error',signal,
        headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body});
      const chunks=[];let bytes=0;
      if(r.body) for await(const chunk of r.body) {
        bytes+=chunk.length;if(bytes>2000000) throw Error('Oversized JEV response; no retry.');chunks.push(chunk);
      }
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await fs.writeFile(`${responseDir}/${key.replaceAll(':','-')}.json`,JSON.stringify({
        at:new Date().toISOString(),status:r.status,decisionRequest:payload.body,
        requestBodySha256:payload.inputSha256,data},null,2),{flag:'wx'});
      if(!r.ok||data.error) throw Error(`JEV HTTP ${r.status}; no retry.`);
      if(!Number.isFinite(data.usage?.cost)||data.usage.cost<0||data.usage.cost>0.02) throw Error('Unbounded or missing JEV billing evidence.');
      return {model:data.model,cost:data.usage.cost,answers:answersFrom(data,payload.body.state.candidates.length)};
    }};
}
