import {instagramProfileUrl} from './musician-instagram-matching.mjs';

const norm=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export const releaseTitle=text=>String(text??'').replace(/\s\(\d{4}-\d{2}-\d{2}\)$/,'').split(' — ')[0];
const handle=url=>instagramProfileUrl(url)?.split('/')[3];

// Search formatting is an attribution clue, not a fetched post or an ownership decision.
function attribution(e,candidateUrl,text) {
  let u;
  try {
    u=new URL(e.sourceUrl);
    if(u.protocol!=='https:'||u.username||u.password||u.port
      ||!['instagram.com','www.instagram.com','m.instagram.com'].includes(u.hostname))return 'unconfirmed';
  } catch {return 'unconfirmed';}
  const parts=u.pathname.split('/').filter(Boolean);
  const captionOwner=/(?:likes?|comments?)\s*[-–]\s*([a-z0-9._]{1,30})\s+on\b/i.exec(text)?.[1]?.toLowerCase();
  const urlOwner=['p','reel','reels','tv'].includes(parts[1])?parts[0].toLowerCase():undefined;
  if(!['p','reel','reels','tv'].includes(parts[0])&&!urlOwner)return 'unconfirmed';
  const owner=urlOwner??captionOwner;
  if(urlOwner&&captionOwner&&urlOwner!==captionOwner)return 'conflicting_owner_clues';
  if(owner)return owner===handle(candidateUrl)?'candidate_owned_post_search_snippet':'third_party_post';
  return 'unconfirmed';
}

function contentCautions(text) {
  const n=norm(text);
  const composed=String(text).normalize('NFKC').toLowerCase();
  return [
    ['fan_or_tribute',/\b(fan\s*(made|page|account|video)|fanmade|tribute|homenaje|hommage|tributo|fanowski|fankonto)\b|粉丝|粉絲|ファンメイド|팬메이드/u],
    ['cover_or_rework',/\b(cover|covers|mashup|mash up|remix|reaction|version|wersja)\b|кавер|翻唱|カバー|커버/u],
    ['collaboration_or_credit',/\b(feat|featuring|ft|collab|collaboration|with|con|avec|prod|produced|producer|label|records|record label|sello|discografica|wytwornia)\b|レーベル|唱片公司|레이블|совместно|коллаб/u],
  ].filter(([,pattern])=>pattern.test(n)||pattern.test(composed)).map(([label])=>label);
}

/** Bounded, deterministic release consistency only. Never feeds the acceptance gate. */
export function postReleaseSignals(context,candidate,evidence=[],limit=3) {
  if(!Array.isArray(evidence)||!Number.isInteger(limit)||limit<0||limit>3)throw Error('Invalid bounded post evidence.');
  const releases=[...new Map((context?.items??[]).filter(i=>i.kind==='release')
    .slice(0,16).map(i=>[norm(releaseTitle(i.text)),i])).entries()]
    .filter(([title])=>title.replaceAll(' ','').length>=5);
  const records=[],seen=new Set();
  let truncated=0;
  for(const e of evidence.slice(0,40)) {
    const title=String(e.title??'').slice(0,240),snippet=String(e.snippet??'').slice(0,1200);
    const sourceUrl=String(e.sourceUrl??'');
    if(sourceUrl.length>500){truncated++;continue;}
    const text=`${title} ${snippet}`,normalized=` ${norm(text)} `;
    const hashtags=new Set([...text.matchAll(/#([\p{L}\p{M}\p{N}_]+)/gu)].map(m=>norm(m[1]).replaceAll(' ','')));
    const clipped=title!==String(e.title??'')||snippet!==String(e.snippet??'');
    if(clipped)truncated++;
    // Direct-profile snippets already have their own signal; do not call them posts.
    if(!String(e.kind??'').startsWith('post_'))continue;
    for(const [normalizedTitle,item] of releases) {
      const exact=normalized.includes(` ${normalizedTitle} `);
      if(!exact&&!hashtags.has(normalizedTitle.replaceAll(' ','')))continue;
      const key=JSON.stringify([sourceUrl,title,snippet,normalizedTitle]);
      if(seen.has(key))continue;
      seen.add(key);
      records.push({releaseTitle:releaseTitle(item.text),match:exact?'title_text':'hashtag',
        attribution:attribution(e,candidate.url,text),kind:e.kind,sourceUrl,title,snippet,
        observedAt:e.observedAt??e.asOf??null,publishedAt:e.date??e.publishedAt??null,
        releaseSource:{source:item.source,sourceUrl:item.sourceUrl,asOf:item.asOf??null,stale:item.stale===true},
        cautions:[...contentCautions(`${text} ${String(candidate.bio??'').slice(0,1600)}`),
          ...(clipped?['truncated_text']:[])],
        ...(clipped?{textTruncated:true}:{})});
    }
  }
  records.sort((a,b)=>Number(b.attribution==='candidate_owned_post_search_snippet'&&!b.cautions.length)
    -Number(a.attribution==='candidate_owned_post_search_snippet'&&!a.cautions.length));
  const matches=records.slice(0,limit);
  return {result:matches.some(m=>m.attribution==='candidate_owned_post_search_snippet'&&!m.cautions.length)?'support':'no_information',
    note:'Release consistency only, not ownership proof. Search-snippet owner attribution is unconfirmed; fans, covers, collaborators and unrelated entities may use the same titles. Dates are source claims; null means unknown.',
    matches,diagnostics:{availableEvidence:evidence.length,inspectedEvidence:Math.min(evidence.length,40),
      uninspectedEvidence:Math.max(0,evidence.length-40),truncatedEvidence:truncated,
      matchedRecords:records.length,retainedRecords:matches.length,omittedRecords:records.length-matches.length}};
}
