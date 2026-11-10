import {instagramProfileUrl} from './musician-instagram-matching.mjs';

const postTypes=new Set(['p','reel','reels','tv']);
const handle=value=>instagramProfileUrl(`https://www.instagram.com/${value}/`)?.split('/')[3];
const count=String.raw`\d[\d,.]*(?:[KM])?\+?`;
const metrics=String.raw`${count}\s+likes?(?:,\s*${count}\s+comments?)?|${count}\s+comments?`;
// Deliberately allowlisted. Localized/changed headers and coauthor lists require
// their own reviewed formats, not a fallback scan of arbitrary caption text.
const date=String.raw`(?:(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)`;
const header=new RegExp(String.raw`^\s*(?:${metrics})\s*[-–]\s*([a-z0-9._]{1,30})\s+on\s+${date}\s*:`, 'i');
const unknownHeader=new RegExp(String.raw`^\s*(?:${metrics})\s*[-–]`, 'i');

/** Interpret source URL and snippet independently; titles/caption mentions are not headers. */
export function instagramPostOwnerClues(sourceUrl,snippet) {
  let u;
  try {
    u=new URL(sourceUrl);
    if(u.protocol!=='https:'||u.username||u.password||u.port
      ||!['instagram.com','www.instagram.com','m.instagram.com'].includes(u.hostname))return {isPost:false};
  } catch {return {isPost:false};}
  const parts=u.pathname.split('/').filter(Boolean);
  const bare=parts.length===2&&postTypes.has(parts[0]);
  const scoped=parts.length===3&&postTypes.has(parts[1]);
  if(!bare&&!scoped)return {isPost:false};
  // _c/_b are observed Instagram routing prefixes, not account handles.
  const urlOwner=scoped&&!['_b','_c'].includes(parts[0].toLowerCase())?handle(parts[0]):undefined;
  const text=String(snippet??'');
  const matched=header.exec(text);
  const captionOwner=matched?handle(matched[1]):undefined;
  return {isPost:true,urlOwner,captionOwner,
    unknownFormat:(!captionOwner&&unknownHeader.test(text))||(scoped&&!urlOwner)};
}

export function instagramPostAttribution(sourceUrl,snippet,candidateUrl) {
  const {isPost,urlOwner,captionOwner,unknownFormat}=instagramPostOwnerClues(sourceUrl,snippet);
  if(!isPost||unknownFormat)return 'unconfirmed';
  if(urlOwner&&captionOwner&&urlOwner!==captionOwner)return 'conflicting_owner_clues';
  const owner=urlOwner??captionOwner;
  if(!owner)return 'unconfirmed';
  return owner===instagramProfileUrl(candidateUrl)?.split('/')[3]
    ?'candidate_owned_post_search_snippet':'third_party_post';
}
