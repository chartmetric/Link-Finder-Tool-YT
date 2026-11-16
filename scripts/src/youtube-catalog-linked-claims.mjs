import assert from 'node:assert/strict';
import {returnedYoutubeUrl} from './youtube-ownership-policy.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
const quoted=s=>"'"+s.replaceAll('\\','\\\\').replaceAll("'","\\'")+"'";
const numericIds=rows=>[...new Set(rows.map(r=>{assert.match(r,/^\d+$/);return r;}))];

// Broad token prefilter only: exact URL/alias identity is ALWAYS checked again
// in JavaScript. Percent-decoding, case folding, all allowed hosts, HTTP
// aliases, repeated slashes and channel tabs remain covered. Non-ASCII or
// unusual handles deliberately fall back to all YouTube accounts.
export function youtubeClaimTokenFilter(claims){
  assert.ok(Array.isArray(claims)&&claims.length);
  const urls=claims.map(c=>returnedYoutubeUrl(c.alias));
  assert.ok(urls.every(Boolean),'Invalid expected YouTube alias');
  const tokens=urls.map(u=>u.split('/').at(-1));
  if(tokens.some(t=>!/^[A-Za-z0-9_.@-]+$/.test(t)))return '';
  return ' AND ('+[...new Set(tokens)].map(t=>
    `positionCaseInsensitive(decodeURLComponent(ifNull(account_url,'')),${quoted(t)})>0`).join(' OR ')+')';
}
export async function catalogLinkedYoutubeClaims(claims,query){
  const read=sql=>catalogReadWithOneTimeoutRetry(query,sql);
  const accounts=await read(`SELECT toString(id) account_id,account_url FROM new_vertical.account FINAL
    WHERE lower(platform)='youtube' AND notEmpty(trim(ifNull(account_url,'')))${youtubeClaimTokenFilter(claims)}`);
  assert.ok(Array.isArray(accounts));
  const relevant=accounts.filter(a=>{
    const alias=returnedYoutubeUrl(a.account_url);
    return alias&&claims.some(c=>c.alias.toLowerCase()===alias.toLowerCase()
      ||(c.channelId&&alias==='https://www.youtube.com/channel/'+c.channelId));
  });
  const ids=numericIds(relevant.map(a=>a.account_id));
  if(!ids.length)return [];
  const links=await read(`SELECT toString(profile_id) profile_id,toString(account_id) account_id
    FROM new_vertical.l_profile_account FINAL WHERE account_id IN (${ids.join(',')})`);
  assert.ok(Array.isArray(links));
  for(const link of links)assert.ok(ids.includes(link.account_id),'Unexpected linked account');
  const profiles=numericIds(links.map(l=>l.profile_id));
  if(!profiles.length)return [];
  const artists=await read(`SELECT toString(id) profile_id,toString(cm_source_id) cm_artist
    FROM new_vertical.profile FINAL WHERE id IN (${profiles.join(',')})`);
  assert.ok(Array.isArray(artists));
  assert.equal(new Set(artists.map(a=>a.profile_id)).size,artists.length);
  return links.flatMap(l=>relevant.filter(a=>a.account_id===l.account_id).map(a=>({
    profile_id:l.profile_id,cm_artist:artists.find(p=>p.profile_id===l.profile_id)?.cm_artist??'',
    account_url:a.account_url})));
}
