// SYNTHETIC collector contract fixtures, never real artist trust observations.
import {createHash} from 'node:crypto';

export const at='2026-11-09T19:00:00Z';
export const now=Date.parse('2026-11-09T20:00:00Z');
export const music='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
export const website='https://artist.example/';
export const channel='https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa';
export const ig='https://www.instagram.com/example_artist_/';
export const hash=body=>createHash('sha256').update(body).digest('hex');
export function player(platform='spotify'){
  return {profile_id:'1',account_ids:['11'],accounts:[{profile_id:'1',account_id:'11',
    platform,account_url:platform==='spotify'?music:channel}]};
}
export function spotifyBody({id='A'.repeat(22),links=[{name:'Official Website',url:website}],footer=''}={}){
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props:{pageProps:{state:{data:{entity:{type:'artist',uri:`spotify:artist:${id}`,
      externalLinks:{items:links}}}}}},
  })}</script>${footer}`;
}
export function youtubeBody({id=channel.split('/').at(-1),links=[{title:{simpleText:'Official Website'},
  navigationEndpoint:{urlEndpoint:{url:website}}}],footer=''}={}){
  return `<script>var ytInitialData = ${JSON.stringify({
    metadata:{channelMetadataRenderer:{externalId:id}},
    contents:{twoColumnBrowseResultsRenderer:{tabs:[{tabRenderer:{title:'About',selected:true,
      content:{sectionListRenderer:{contents:[{itemSectionRenderer:{contents:[
        {channelAboutFullMetadataRenderer:{channelId:id,primaryLinks:links}},
      ]}}]}}}}]}},
  })};</script>${footer}`;
}
export function archive({platform='spotify',body,sourceUrl,finalUrl,observedAt=at,redirects=[]}={}){
  const url=platform==='spotify'?music:`${channel}/about`;
  body??=platform==='spotify'?spotifyBody():youtubeBody();
  return {kind:'catalog_profile_http',sourceUrl:sourceUrl??url,finalUrl:finalUrl??sourceUrl??url,
    status:200,observedAt,body,bodySha256:hash(body),redirects};
}
export function options(overrides={}){
  return {player:player(),archives:[archive()],now,maxEvidenceAgeMs:86400000,...overrides};
}
export const collectorCases={
  redirect:()=>archive({finalUrl:music.replace('/artist/','/embed/artist/'),
    redirects:[{sourceUrl:music,finalUrl:music.replace('/artist/','/embed/artist/'),status:302}]}),
  publisherFooter:()=>archive({body:spotifyBody({links:[],
    footer:`<footer>Published by Label <a href="${website}">Official Website</a>
      <a href="${music}">Artist</a><a href="${ig}">Instagram</a></footer>`})}),
  staleDeclaration:()=>archive({observedAt:'2025-01-01T00:00:00Z'}),
  wrongArtist:()=>archive({body:spotifyBody({id:'B'.repeat(22)})}),
};
