import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { musicPageUrl } from './public-music-links.mjs';

export function isPublicIPv4(address) {
  if (isIP(address)!==4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127)
    || (a===169 && b===254) || (a===172 && b>=16 && b<=31)
    || (a===192 && (b===168 || b===0 || (b===88 && c===99)))
    || (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
}

/** HTTPS with fixed allowlist, public IPv4 only, DNS/socket pinning, TLS host
 * validation, no automatic redirects, credentials, cookies, proxies or JS. */
export async function safeMusicFetch(value,{signal,lookup=dnsLookup,request=https.request}={}) {
  const safe = musicPageUrl(String(value));
  if (!safe) throw new Error('Unsafe or unsupported music URL.');
  signal?.throwIfAborted();
  const u = new URL(safe);
  const records = await lookup(u.hostname,{all:true,family:4,verbatim:true});
  signal?.throwIfAborted();
  if (!records.length || records.some(r=>!isPublicIPv4(r.address))) throw new Error('Music host did not resolve exclusively to public IPv4 addresses.');
  const address = records[0].address;
  return new Promise((resolve,reject)=>{
    const req = request(u,{method:'GET',agent:false,signal,servername:u.hostname,
      headers:{Accept:'text/html,application/json;q=0.9','User-Agent':'ProfileHandlesOnline-IdentityEvidence/1.0'},
      lookup:(_hostname,options,cb)=>options.all
        ? cb(null,[{address,family:4}]) : cb(null,address,4)},res=>{
      const headers = new Headers();
      if (res.headers.location) headers.set('location',res.headers.location);
      if (res.headers['content-type']) headers.set('content-type',res.headers['content-type']);
      // Cookies and unrelated headers never leave this narrow client.
      if ([204,205,304].includes(res.statusCode)) {
        res.resume();
        resolve(new Response(null,{status:res.statusCode,headers}));
      } else resolve(new Response(Readable.toWeb(res),{status:res.statusCode,headers}));
    });
    req.on('error',reject);
    req.end();
  });
}
