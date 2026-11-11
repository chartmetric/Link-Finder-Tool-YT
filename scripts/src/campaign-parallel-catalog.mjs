// Read-only catalog transport. Never used for paid search, scrape or model calls.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const transientCodes=new Set([159,202,209,210,241]);
const networkCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT']);
export const CATALOG_RETRY_POLICY=Object.freeze({attempts:3,backoffMs:[1500,4000],
  requestTimeoutMs:40000,maxExecutionSeconds:30});
const digest=s=>createHash('sha256').update(s).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function recordDiagnostic(event){
  const entry={at:new Date().toISOString(),...event};
  console.error(JSON.stringify(entry));
  const directory=path.dirname(fileURLToPath(import.meta.url));
  if(path.basename(directory)==='runtime')
    await fs.appendFile(path.join(directory,'../catalog-read-diagnostics.jsonl'),JSON.stringify(entry)+'\n');
}
function retryable(status,code){
  if([400,401,403,404].includes(status))return false;
  if(code!=null)return transientCodes.has(code);
  return [408,429,500,502,503,504].includes(status);
}
async function exceptionCode(response){
  const header=response.headers.get('x-clickhouse-exception-code');
  if(/^\d+$/.test(header??''))return Number(header);
  // Read only a bounded error prefix to classify it; never log its raw text.
  const reader=response.body?.getReader();if(!reader)return null;
  const chunks=[];let bytes=0;
  try{
    while(bytes<4096){
      const {done,value}=await reader.read();if(done)break;
      const part=value.subarray(0,4096-bytes);chunks.push(Buffer.from(part));bytes+=part.length;
    }
  }catch{/* Unknown response body remains an unknown server error. */}
  finally{await reader.cancel().catch(()=>{});}
  const match=Buffer.concat(chunks).toString('utf8').match(/^Code:\s*(\d+)\b/);
  return match?Number(match[1]):null;
}
export function createCatalogReader({fetchImpl=fetch,sleep=wait,env=process.env,
  onDiagnostic=recordDiagnostic,idFactory=randomUUID}={}){
  return async function catalogSelect(query,{queryKind}={}){
    assert.match(query,/^SELECT\b/,'Catalog transport accepts SELECT only');
    assert.ok(env.CLICKHOUSE_VERT_HOST&&env.CLICKHOUSE_USERNAME&&env.CLICKHOUSE_PASSWORD,
      'Catalog configuration unavailable');
    const host=env.CLICKHOUSE_VERT_HOST,url=new URL(/^https:\/\//.test(host)?host:`https://${host}`);
    assert.ok(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/',
      'Invalid secure catalog endpoint');
    assert.ok(!['google.serper.dev','api.scrapecreators.com','openrouter.ai'].includes(url.hostname),
      'Paid-provider endpoints are forbidden in catalog retry transport');
    const kind=queryKind??query.match(/\b(?:FROM|JOIN)\s+new_vertical\.([a-z_][a-z0-9_]*)/i)?.[1]??'catalog_read';
    const label=/^[a-z_][a-z0-9_]{0,63}$/i.test(kind)?kind:'catalog_read';
    const querySha256=digest(query);
    for(let attempt=1;attempt<=CATALOG_RETRY_POLICY.attempts;attempt++){
      const queryId=idFactory();let status=null,code=null,reason='catalog_network_failure',canRetry=false;
      try{
        const endpoint=new URL(url);endpoint.searchParams.set('readonly','1');
        endpoint.searchParams.set('max_execution_time',String(CATALOG_RETRY_POLICY.maxExecutionSeconds));
        endpoint.searchParams.set('query_id',queryId);
        const r=await fetchImpl(endpoint,{method:'POST',redirect:'error',
          signal:AbortSignal.timeout(CATALOG_RETRY_POLICY.requestTimeoutMs),
          headers:{'X-ClickHouse-User':env.CLICKHOUSE_USERNAME,'X-ClickHouse-Key':env.CLICKHOUSE_PASSWORD},
          body:query+' FORMAT JSON'});
        status=r.status;
        if(r.ok){
          let body;
          try{body=await r.json();}catch{reason='catalog_invalid_json';throw Error(reason);}
          if(!Array.isArray(body?.data)){reason='catalog_invalid_rows';throw Error(reason);}
          return body.data;
        }
        code=await exceptionCode(r);reason='catalog_http_failure';canRetry=retryable(status,code);
      }catch(error){
        // Neither arbitrary TypeErrors nor schema/protocol failures are assumed transient.
        if(status==null){
          const networkCode=error.cause?.code??error.code;
          canRetry=error.name==='TimeoutError'||networkCodes.has(networkCode);
          reason=error.name==='TimeoutError'?'catalog_read_timeout':'catalog_network_failure';
        }
      }
      const again=canRetry&&attempt<CATALOG_RETRY_POLICY.attempts;
      const detail={event:again?'catalog_read_retry':'catalog_read_stopped',queryKind:label,
        querySha256,queryId,attempt,httpStatus:status,exceptionCode:code,reason,
        retryDelayMs:again?CATALOG_RETRY_POLICY.backoffMs[attempt-1]:0};
      await onDiagnostic(detail);
      if(!again){
        const error=Error('Catalog read stopped; sanitized diagnostic recorded');
        // The inherited stop serializer already retains safe uppercase codes.
        error.code=status!=null?`CATALOG_HTTP_${status}_CH_${code??'UNKNOWN'}`:
          reason==='catalog_read_timeout'?'CATALOG_READ_TIMEOUT':'CATALOG_READ_FAILED';
        error.catalogDiagnostic=detail;throw error;
      }
      await sleep(CATALOG_RETRY_POLICY.backoffMs[attempt-1]);
    }
  };
}
export const catalogSelect=createCatalogReader();
