import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {youtubeArtistSearchQuery,rankYoutubeMusicCandidates} from './youtube-music-search.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';

export const youtubeTestSchema = `
CREATE TABLE IF NOT EXISTS youtube_discovery_test_runs (
 id text PRIMARY KEY, owner uuid NOT NULL, scope_sha256 text NOT NULL,
 cap_cents integer NOT NULL CHECK(cap_cents>0 AND cap_cents<=200),
 reserved_cents integer NOT NULL DEFAULT 0 CHECK(reserved_cents>=0 AND reserved_cents<=cap_cents),
 status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS youtube_discovery_test_results (
 run_id text NOT NULL REFERENCES youtube_discovery_test_runs(id),
 profile_id text NOT NULL, cm_artist text NOT NULL, artist text NOT NULL,
 tier integer NOT NULL CHECK(tier BETWEEN 1 AND 5),
 status text NOT NULL, candidates_json jsonb NOT NULL DEFAULT '[]',
 metadata_json jsonb NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,profile_id)
);`;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const root = 'generated-artifacts/youtube-no-link-20-usd2';
export const youtubeEligibilitySql = `SELECT * FROM (
WITH latest_snapshot AS (
 SELECT max(computed_at) snapshot_at FROM new_vertical.l_profile_tier FINAL
 WHERE grain='global' AND profile_type='musician'
), tier_assignments AS (
 SELECT profile,argMax(tier,tuple(computed_at,updated_at)) tier,
 argMax(tier_rank,tuple(computed_at,updated_at)) tier_rank
 FROM new_vertical.l_profile_tier FINAL
 WHERE grain='global' AND profile_type='musician'
 AND computed_at=(SELECT snapshot_at FROM latest_snapshot)
 GROUP BY profile HAVING tier BETWEEN 1 AND 5
), linked AS (
 SELECT DISTINCT l.profile_id
 FROM new_vertical.l_profile_account l FINAL
 INNER JOIN new_vertical.account a FINAL ON a.id=l.account_id
 WHERE l.disconnected_at IS NULL AND lower(a.platform)='youtube'
 AND notEmpty(trim(ifNull(a.account_url,'')))
)
SELECT toString(p.id) profile_id,toString(p.cm_source_id) cm_artist,
 p.name artist,t.tier tier,t.tier_rank tier_rank,
 toString((SELECT snapshot_at FROM latest_snapshot),'UTC') snapshot_at
FROM new_vertical.profile p FINAL INNER JOIN tier_assignments t ON t.profile=p.id
WHERE p.cm_source='cm_artist' AND p.deleted_at IS NULL AND p.id NOT IN (SELECT profile_id FROM linked)
ORDER BY t.tier,t.tier_rank,p.id LIMIT 4 BY t.tier)`;

export function youtubeChannelUrl(raw) {
  try {
    const url=new URL(raw);
    if(url.protocol!=='https:'||!['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(url.hostname))return null;
    const parts=url.pathname.split('/').filter(Boolean);
    if(parts.length===1&&/^@[^/?#]+$/.test(parts[0]))
      return 'https://www.youtube.com/'+parts[0];
    if(parts.length===2&&parts[0]==='channel'&&/^UC[A-Za-z0-9_-]{22}$/.test(parts[1]))
      return 'https://www.youtube.com/channel/'+parts[1];
    if(parts.length===2&&['c','user'].includes(parts[0])&&/^[\w.-]+$/.test(parts[1]))
      return 'https://www.youtube.com/'+parts.join('/');
    return null;
  } catch {return null;}
}
export function youtubeSearchCandidates(data) {
  assert.ok(Array.isArray(data.organic),'Missing organic search results; not a completed no-match.');
  const seen=new Set();
  return data.organic.flatMap(result=>{
    const url=youtubeChannelUrl(result.link);
    if(!url||seen.has(url))return [];
    seen.add(url);
    return [{url,title:String(result.title??''),snippet:String(result.snippet??''),
      sourceUrl:String(result.link),source:'serper',verified:false}];
  });
}
const save=(name,value)=>fs.writeFile(root+'/'+name,JSON.stringify(value,null,2),{flag:'wx'});
const read=async name=>JSON.parse(await fs.readFile(root+'/'+name,'utf8'));
export async function runYoutubeTest(live=false) {
  const pool=await connectSavedBatchPool();
  try {
    if(!live){
      const scope=await select(youtubeEligibilitySql);
      assert.equal(scope.length,20);
      for(const t of [1,2,3,4,5])assert.equal(scope.filter(r=>Number(r.tier)===t).length,4);
      assert.equal(new Set(scope.map(r=>r.profile_id)).size,20);
      assert.ok(scope.every(r=>/^\d+$/.test(r.profile_id)&&/^\d+$/.test(r.cm_artist)));
      assert.ok(Date.now()-Date.parse(scope[0].snapshot_at.replace(' ','T')+'Z')<36*3600000,'Tier snapshot stale.');
      const ids=scope.map(r=>r.profile_id).join(',');
      const cms=scope.map(r=>r.cm_artist).join(',');
      const metadata=await select(`SELECT toString(p.id) profile_id,toString(p.cm_source_id) cm_artist,
        p.name artist,ifNull(c.code2,'') country,ifNull(c.label,'') label,ifNull(c.record_label,'') record_label
        FROM (SELECT id,cm_source_id,name FROM new_vertical.profile FINAL WHERE id IN (${ids}) AND cm_source='cm_artist') p
        LEFT JOIN (SELECT id,code2,label,record_label FROM new_vertical.cm_artist FINAL WHERE id IN (${cms})) c ON toString(c.id)=toString(p.cm_source_id)`);
      assert.equal(metadata.length,scope.length);
      const approval={id:'youtube-no-link-20-usd2',scope,metadata,scopeSha256:digest(scope),
        capCents:200,artists:20,reservationPerSearchCents:2,
        approvedBy:'User approved the proposed 20-artist YouTube test with a separate $2 cap.',
        discoveryOnly:true,noLiveLinkChanges:true,noAutomaticRetries:true,createdAt:new Date().toISOString()};
      await fs.mkdir(root,{recursive:false});
      await save('approval.json',approval);
      await pool.query(youtubeTestSchema);
      console.log(JSON.stringify({status:'prepared',artists:20,capUsd:2,paidCalls:0}));
      return;
    }
    assert.ok(process.env.SERPERDEV_API_KEY,'Missing search provider credential.');
    const approval=await read('approval.json');
    assert.equal(approval.scopeSha256,digest(approval.scope));assert.equal(approval.capCents,200);
    assert.equal(approval.scope.length,20);assert.equal(approval.discoveryOnly,true);
    // Revalidate the exact cohort immediately before the first paid request.
    const fresh=await select(youtubeEligibilitySql);
    assert.deepEqual(fresh,approval.scope,'Eligibility changed; no paid work.');
    const owner=randomUUID(),id=approval.id;
    await pool.query('INSERT INTO youtube_discovery_test_runs(id,owner,scope_sha256,cap_cents,status) VALUES($1,$2,$3,$4,$5)',
      [id,owner,approval.scopeSha256,200,'running']);
    const codeHash=digest(await fs.readFile(fileURLToPath(import.meta.url),'utf8'));
    const outcomes=[];
    for(const target of approval.scope){
      assert.equal(codeHash,digest(await fs.readFile(fileURLToPath(import.meta.url),'utf8')),'Code changed; no further paid calls.');
      const metadata=approval.metadata.find(r=>r.profile_id===target.profile_id);
      assert.equal(metadata.cm_artist,target.cm_artist);
      const request={q:youtubeArtistSearchQuery(target),num:10};
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const {rows}=await client.query('SELECT * FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE',[id]);
        assert.equal(rows[0].owner,owner);assert.equal(rows[0].status,'running');
        assert.ok(rows[0].reserved_cents+2<=200,'Spending cap reached.');
        await client.query(`INSERT INTO youtube_discovery_test_results
          (run_id,profile_id,cm_artist,artist,tier,status,metadata_json) VALUES($1,$2,$3,$4,$5,'admitted',$6)`,
          [id,target.profile_id,target.cm_artist,target.artist,Number(target.tier),JSON.stringify(metadata)]);
        await client.query('UPDATE youtube_discovery_test_runs SET reserved_cents=reserved_cents+2 WHERE id=$1',[id]);
        await client.query('COMMIT');
      } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
      // An admitted request is never automatically retried, even after interruption.
      await fs.appendFile(root+'/admissions.jsonl',JSON.stringify({at:new Date().toISOString(),profileId:target.profile_id,request,reservedCents:2})+'\n');
      let status,candidates=[],searchRanking=null;
      try {
        const response=await fetch('https://google.serper.dev/search',{method:'POST',
          headers:{'X-API-KEY':process.env.SERPERDEV_API_KEY,'Content-Type':'application/json'},
          body:JSON.stringify(request),signal:AbortSignal.timeout(30000),redirect:'error'});
        const text=await response.text();
        assert.ok(text.length<2000000,'Oversized search response.');
        const packet=JSON.parse(text);
        await save('response-'+target.profile_id+'.json',{status:response.status,request,body:packet});
        if(!response.ok||packet.error||/insufficient.{0,20}credit|not enough credits|invalid api.?key/i.test(JSON.stringify(packet)))
          throw Error('Search provider failed; stopped without retry.');
        searchRanking=rankYoutubeMusicCandidates(target,youtubeSearchCandidates(packet));
        candidates=searchRanking.candidates;
        status=searchRanking.allCandidates.length?'candidates_found':'no_match';
      }catch(e){
        await pool.query(`UPDATE youtube_discovery_test_results SET status='failed',checked_at=now() WHERE run_id=$1 AND profile_id=$2`,[id,target.profile_id]);
        await pool.query("UPDATE youtube_discovery_test_runs SET status='stopped' WHERE id=$1",[id]);
        await save('stopped.json',{profileId:target.profile_id,reason:'Search request failed or is uncertain; no retry.',reservedChargeRetained:true});
        throw e;
      }
      const outcome={...target,status,candidates,allSearchCandidates:searchRanking?.allCandidates??[],
        relatedTopicCandidates:searchRanking?.relatedTopicCandidates??[],artistMetadata:metadata,verified:false};
      await save('artist-'+target.profile_id+'.json',outcome);
      await pool.query(`UPDATE youtube_discovery_test_results SET status=$3,candidates_json=$4,checked_at=now()
        WHERE run_id=$1 AND profile_id=$2`,[id,target.profile_id,status,JSON.stringify(candidates)]);
      outcomes.push(outcome);
      console.log(JSON.stringify({processed:outcomes.length,total:20,candidates:outcomes.filter(r=>r.candidates.length).length,reservedUsd:outcomes.length*.02}));
    }
    await pool.query("UPDATE youtube_discovery_test_runs SET status='completed' WHERE id=$1",[id]);
    await save('summary.json',{status:'completed',artists:20,artistsWithCandidates:outcomes.filter(r=>r.candidates.length).length,
      noMatch:outcomes.filter(r=>!r.candidates.length).length,reservedUsd:.4,maximumSpendUsd:2,verified:0,noLiveLinkChanges:true});
    const fields=['artist','profile_id','cm_artist','tier','status','youtubeUrl','title','snippet','artistMetadata','verified'];
    const rows=outcomes.flatMap(r=>(r.candidates.length?r.candidates:[{}]).map(c=>({
      ...r,youtubeUrl:c.url??'',title:c.title??'',snippet:c.snippet??''})));
    const cell=v=>{let s=typeof v==='object'?JSON.stringify(v):String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
    await fs.writeFile(root+'/youtube-findings.csv','\ufeff'+[fields,...rows.map(r=>fields.map(f=>r[f]))].map(r=>r.map(cell).join(',')).join('\r\n'),{flag:'wx'});
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  await runYoutubeTest(process.argv.includes('--run-approved'));
