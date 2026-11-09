// Deterministic comparison of saved catalog facts with one candidate account.
// Output is support / contradiction / no_information; missing facts never count against an account.
const norm=s=>String(s??'').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const handleOf=url=>{try{const u=new URL(url);return u.pathname.split('/').filter(Boolean)[0]?.toLowerCase()??'';}catch{return '';}};
const titleOf=text=>text.replace(/\s\(\d{4}-\d{2}-\d{2}\)$/,'').split(' — ')[0];

export function contextSignals(context,candidate,artist) {
  const items=context?.items??[];
  const haystack=norm(`${candidate?.displayName??''} ${candidate?.bio??''}`);
  const titles=[...new Set(items.filter(i=>i.kind==='release').map(i=>titleOf(i.text)).filter(t=>norm(t).length>=5))];
  const matched=titles.filter(t=>` ${haystack} `.includes(` ${norm(t)} `)).slice(0,3);
  const candidateHandle=handleOf(candidate?.url);
  const linked=new Set(),other=new Set();
  for(const i of items.filter(i=>i.kind==='bio'||i.kind==='spotify_biography')) {
    for(const [,h] of String(i.text).matchAll(/instagram\.com\/([A-Za-z0-9._]+)/gi)) {
      (h.toLowerCase()===candidateHandle?linked:other).add(h.toLowerCase());
    }
  }
  const name=norm(artist);
  const nameHit=name.length>=3&&(` ${haystack} `.includes(` ${name} `)||norm(candidateHandle).replaceAll(' ','').includes(name.replaceAll(' ','')));
  return {
    songTitlesInCandidateProfile:matched.length?{result:'support',titles:matched}:{result:'no_information',checkedTitles:titles.length},
    otherPlatformBioLinksToCandidate:linked.size?{result:'support'}
      :other.size?{result:'contradiction',note:'A saved bio on another platform links a different Instagram handle.',handles:[...other].slice(0,2)}
      :{result:'no_information'},
    artistNameInCandidateProfile:nameHit?{result:'support'}:{result:'no_information'},
    note:'Signals compare saved catalog facts with this candidate. no_information is not evidence against it.',
  };
}
