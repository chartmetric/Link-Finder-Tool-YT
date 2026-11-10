import {referenceUrl} from './musician-instagram-matching.mjs';

// Only these same-identity profile representations may redirect to each other.
export function catalogProfileIdentity(value,platform){
  try{
    const u=new URL(value);
    if(u.search||u.hash||String(value).includes('\\'))return null;
    if(platform==='spotify')u.pathname=u.pathname.replace(/^\/embed\/artist\//,'/artist/');
    if(platform==='youtube')u.pathname=u.pathname.replace(/\/about\/?$/,'');
    return referenceUrl(u.href,platform);
  }catch{return null;}
}
