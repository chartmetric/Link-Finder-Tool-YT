import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceKey,exactCatalogCrosslinks} from './audit-youtube-held-28.mjs';
import {digest} from './youtube-video-discovery-offline.mjs';
test('matches exact artist resources while ignoring tracking but preserving Spotify ID case',()=>{
  const id='3UvBjnS0xNdifivRctkxok';
  assert.equal(referenceKey('https://open.spotify.com/artist/'+id+'?si=tracking'),
    'spotify:artist:'+id);
  assert.equal(referenceKey('https://open.spotify.com/intl-ar/artist/'+id),'spotify:artist:'+id);
  assert.notEqual(referenceKey('https://open.spotify.com/artist/'+id.toLowerCase()),
    'spotify:artist:'+id);
  assert.equal(referenceKey('https://www.instagram.com/Artist.Name/?hl=ja'),'instagram:artist.name');
  assert.equal(referenceKey('https://tiktok.com/@Artist.Name?device=pc'),'tiktok:artist.name');
  assert.equal(referenceKey('https://x.com/Artist_Name'),'twitter:artist_name');
  assert.equal(referenceKey('https://www.facebook.com/profile.php?id=123'),'facebook:id:123');
  assert.equal(referenceKey('https://www.facebook.com/profile.php?id=124'),'facebook:id:124');
});
test('rejects unsafe, lookalike and non-artist resources',()=>{
  for(const url of ['https://open.spotify.com.evil.example/artist/3UvBjnS0xNdifivRctkxok',
    'https://user:pass@instagram.com/artist','https://instagram.com:123/artist',
    'https://instagram.com/p/post','https://tiktok.com/@artist/video/123',
    'https://open.spotify.com/track/3UvBjnS0xNdifivRctkxok','spotify:artist:3UvBjnS0xNdifivRctkxok'])
    assert.equal(referenceKey(url),null,url);
});
test('requires catalog binding and exact active cross-links, not the same name or a new social alias',()=>{
  const artist={profileId:'1',cmArtist:'2',accounts:[
    {profile_id:'1',cm_artist:'2',account_id:'3',is_active:1,disconnected_at:null,
      account_url:'https://instagram.com/existing_artist'}]};
  const body={externalUrls:['https://instagram.com/new_artist_alias']};
  assert.equal(exactCatalogCrosslinks(artist,{body,bodySha256:digest(body)}).length,0);
  body.externalUrls.push('https://www.instagram.com/Existing_Artist/?hl=ja');
  const matches=exactCatalogCrosslinks(artist,{body,bodySha256:digest(body)});
  assert.equal(matches.length,1);assert.equal(matches[0].establishesOwnership,false);
  assert.throws(()=>exactCatalogCrosslinks(artist,{body,bodySha256:'a'.repeat(64)}));
  assert.throws(()=>exactCatalogCrosslinks({...artist,cmArtist:'9'},{body,bodySha256:digest(body)}));
  assert.equal(exactCatalogCrosslinks({...artist,accounts:artist.accounts.map(a=>({...a,disconnected_at:'2026-01-01'}))},
    {body,bodySha256:digest(body)}).length,0);
});
