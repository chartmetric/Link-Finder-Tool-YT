// Narrow public profile transport. Safety does not establish artist ownership.
import https from 'node:https';
import {lookup as dnsLookup} from 'node:dns/promises';
import {createHash} from 'node:crypto';
import {isPublicIPv4} from './safe-music-fetch.mjs';
import {catalogProfileIdentity} from './catalog-profile-identity.mjs';

const bounded=(value,min,max,name)=>{
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`Explicit bounded ${name} required.`);
  return value;
};
function allowedUrl(value,reference){
  return ['spotify','youtube'].includes(reference.platform)
    &&catalogProfileIdentity(value,reference.platform)===reference.url;
}

export function createCatalogProfileReader({
  enabled,maxRequests,maxBytes,timeoutMs,maxRedirects,
  lookup=dnsLookup,request=https.request,
}={}){
  if(enabled!==true)throw new Error('Public fetching requires explicit opt-in.');
  bounded(maxRequests,1,20,'request budget');bounded(maxBytes,1,2_000_000,'body limit');
  bounded(timeoutMs,1,15_000,'timeout');bounded(maxRedirects,0,3,'redirect limit');
  let remaining=maxRequests;
  async function get(url,reference){
    if(!allowedUrl(url,reference))throw new Error('Unsafe/non-catalog profile URL.');
    if(remaining--<=0)throw new Error('Public request budget exhausted; no retries.');
    const signal=AbortSignal.timeout(timeoutMs);
    // Race DNS as well as HTTP; never let a stuck resolver outlive the budget.
    const records=await new Promise((resolve,reject)=>{
      const abort=()=>reject(new Error('Public DNS timeout.'));
      signal.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(()=>lookup(new URL(url).hostname,{all:true,family:4,verbatim:true}))
        .then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
    signal.throwIfAborted();
    if(!records.length||records.some(r=>!isPublicIPv4(r.address)))
      throw new Error('Catalog host must resolve exclusively to public IPv4.');
    const address=records[0].address,u=new URL(url);
    return new Promise((resolve,reject)=>{
      const req=request(u,{method:'GET',agent:false,signal,servername:u.hostname,
        headers:{Accept:'text/html','User-Agent':'ProfileHandlesOnline-OfflineSource/1.0',
          'Accept-Encoding':'identity'},
        lookup:(_host,options,cb)=>options.all?cb(null,[{address,family:4}]):cb(null,address,4)},
      res=>{
        const status=res.statusCode;
        if([301,302,303,307,308].includes(status)){
          const location=res.headers.location;res.destroy();resolve({status,location});return;
        }
        if(status!==200||!/^text\/html(?:;|$)/i.test(res.headers['content-type']??'')
          ||!['identity',undefined].includes(res.headers['content-encoding'])){
          res.destroy();reject(new Error('Unsupported public profile response.'));return;
        }
        let bytes=0;const chunks=[];
        res.on('data',chunk=>{
          bytes+=chunk.length;
          if(bytes>maxBytes){res.destroy();reject(new Error('Public profile body limit exceeded.'));}
          else chunks.push(Buffer.from(chunk));
        });
        res.on('error',reject);
        res.on('aborted',()=>reject(new Error('Public profile response aborted.')));
        res.on('end',()=>{
          const original=Buffer.concat(chunks),body=original.toString('utf8');
          // Hashing a lossy decoding would no longer identify the original body.
          if(!Buffer.from(body,'utf8').equals(original)){
            reject(new Error('Profile body is not lossless UTF-8.'));return;
          }
          resolve({status,body});
        });
      });
      req.on('error',reject);req.end();
    });
  }
  return async reference=>{
    const sourceUrl=reference.platform==='youtube'?`${reference.url}/about`:reference.url;
    let url=sourceUrl;const redirects=[];
    for(;;){
      const response=await get(url,reference);
      if(response.status===200)return {kind:'catalog_profile_http',sourceUrl,finalUrl:url,
        // Fresh public reads get an actual acquisition time, never caller's evaluation time.
        observedAt:new Date().toISOString(),status:200,redirects,body:response.body,
        bodySha256:createHash('sha256').update(response.body).digest('hex')};
      if(redirects.length>=maxRedirects)throw new Error('Public redirect limit exceeded.');
      if(typeof response.location!=='string')throw new Error('Missing profile redirect location.');
      const target=new URL(response.location,url).href;
      if(!allowedUrl(target,reference))throw new Error('Redirect leaves exact catalog artist; not followed.');
      redirects.push({sourceUrl:url,finalUrl:target,status:response.status});url=target;
    }
  };
}
