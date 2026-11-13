// Only read-only ClickHouse queries. Failure is blocking, never an empty result.
import assert from 'node:assert/strict';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {youtubeEligibilitySql} from './youtube-discovery-test.mjs';
import {returnedYoutubeUrl} from './youtube-ownership-policy.mjs';
import {assertNoNewIdentityClaims} from './youtube-video-identity-execution.mjs';

export function identityEligibilitySql(selections){
  assert.ok(selections.length&&selections.every(s=>/^\d+$/.test(s.profileId)&&/^\d+$/.test(s.cmArtist)));
  return youtubeEligibilitySql.replace(' LIMIT 4 BY t.tier','')
    .replace('ORDER BY t.tier,t.tier_rank,p.id',
      `AND p.id IN (${selections.map(s=>s.profileId).join(',')}) ORDER BY t.tier,t.tier_rank,p.id`);
}
export function assertCurrentIdentityEligibility(selections,rows,now=Date.now()){
  assert.equal(rows.length,selections.length,'Current eligibility changed');
  for(const s of selections){
    const r=rows.find(r=>String(r.profile_id)===s.profileId);
    assert.ok(r&&String(r.cm_artist)===s.cmArtist&&r.artist===s.artist
      &&Number(r.tier)===s.tier,'Current catalog identity or global tier changed');
    const at=String(r.snapshot_at);
    const age=now-Date.parse(at.includes('T')?at:at.replace(' ','T')+'Z');
    assert.ok(Number.isFinite(age)&&age>=0&&age<=36*3600000,'Global tier snapshot is stale');
  }
}
export function identityCatalogCheck(plan,{query=select,now=Date.now}={}){
  return async claims=>{
    assertCurrentIdentityEligibility(plan.selections,await query(identityEligibilitySql(plan.selections)),now());
    // Read all linked channel claims, including inactive/disconnected historical
    // links and profiles outside this cohort. Never treat absent current links
    // or a catalog query failure as an ownership clearance.
    const rows=await query(`SELECT toString(l.profile_id) profile_id,toString(p.cm_source_id) cm_artist,
      a.account_url FROM new_vertical.l_profile_account l FINAL
      INNER JOIN new_vertical.account a FINAL ON a.id=l.account_id
      LEFT JOIN new_vertical.profile p FINAL ON p.id=l.profile_id
      WHERE lower(a.platform)='youtube' AND notEmpty(trim(ifNull(a.account_url,'')))`);
    const observed=rows.flatMap(r=>{
      const alias=returnedYoutubeUrl(r.account_url);
      return alias?[{alias,profileId:String(r.profile_id),cmArtist:String(r.cm_artist),
        channelId:alias.match(/\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1]??null}]:[];
    });
    assertNoNewIdentityClaims(claims,observed);
  };
}
