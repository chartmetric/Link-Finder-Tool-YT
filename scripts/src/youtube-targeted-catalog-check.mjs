import assert from 'node:assert/strict';
import {identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
export function targetedCatalogCheck(plan,options){
  return async claims=>{
    assert.ok(claims.length);
    const selections=plan.selections.filter(s=>claims.some(c=>c.profileId===s.profileId&&c.cmArtist===s.cmArtist));
    assert.ok(claims.every(c=>selections.some(s=>c.profileId===s.profileId&&c.cmArtist===s.cmArtist)),
      'Catalog checks cannot introduce a different artist');
    return identityCatalogCheck({...plan,selections},options)(claims);
  };
}
