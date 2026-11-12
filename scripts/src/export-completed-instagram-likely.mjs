// Read-only campaign export. No worker or paid-provider imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const requireDb = createRequire(path.resolve('lib/db/package.json'));
const {Pool} = requireDb('pg');
const campaign = 'full-tiers-1-5-no-ig-usd100';
const root = 'generated-artifacts/instagram-tier-priority';
const out = 'generated-artifacts/instagram-final-likely-export';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const csv = value => {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
const columns = ['artist_name','tier','profile_id','cm_artist','instagram_url',
  'likely_review_suggestion','score','verdict','decision_reason','catalog_link_added',
  'campaign_id','snapshot_utc'];
const pool = new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:10000});
let rows, stamp;
try {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='30s'");
    const run = (await c.query('SELECT status FROM instagram_priority_runs WHERE id=$1',[campaign])).rows[0];
    assert.equal(run?.status,'completed');
    stamp = (await c.query('SELECT transaction_timestamp() stamp')).rows[0].stamp.toISOString();
    rows = (await c.query(`SELECT profile_id,cm_artist,artist,tier,ordinal,result_sha256
      FROM instagram_priority_artists
      WHERE campaign_id=$1 AND checked=true AND likely=true AND tier BETWEEN 1 AND 5
      ORDER BY tier,ordinal`,[campaign])).rows;
    await c.query('COMMIT');
  } catch(e) {await c.query('ROLLBACK').catch(()=>{});throw e;}
  finally {c.release();}
} finally {await pool.end();}
const progress = JSON.parse(await fs.readFile(root+'/parallel-493d5352-9a7f-4d95-a88a-c78c42a8f960/progress.json'));
assert.equal(rows.length,progress.likelyMatches);
assert.equal(new Set(rows.map(r=>r.profile_id)).size,rows.length);
const baseline = new Map(JSON.parse(await fs.readFile(root+'/baseline.json')).map(r=>[String(r.profileId),r]));
await fs.mkdir(out,{recursive:true});
const file = out+'/instagram-likely-matches-all.csv';
const handle = await fs.open(file,'wx');
let count = 0;
try {
  await handle.write('\ufeff'+columns.map(csv).join(',')+'\r\n');
  for(let i=0;i<rows.length;i+=32) {
    const group = await Promise.all(rows.slice(i,i+32).map(async row => {
      let result;
      try {result=JSON.parse(await fs.readFile(root+'/artists/'+row.profile_id+'.json'));}
      catch(e) {if(e.code!=='ENOENT')throw e;result=baseline.get(row.profile_id);}
      assert.ok(result);
      if(row.result_sha256)assert.equal(hash(result),row.result_sha256);
      assert.equal(String(result.profileId),row.profile_id);
      assert.equal(String(result.cmArtist),row.cm_artist);
      assert.equal(Boolean(result.likelyReviewSuggestion??result.likely),true);
      const candidates = (result.candidates??[]).filter(c=>c.reviewSuggestion===true||c.review?.reviewSuggestion===true);
      assert.ok(candidates.length);
      const seen = new Set(), lines = [];
      for(const candidate of candidates) {
        const url=candidate.url||candidate.profileUrl||candidate.metadata?.candidate?.url;
        assert.ok(url,'Likely candidate missing URL');
        const u=new URL(url);
        assert.ok(['instagram.com','www.instagram.com'].includes(u.hostname));
        assert.ok(u.protocol==='https:'&&!/[|\s]/.test(url));
        if(seen.has(url))continue;seen.add(url);
        const answer=candidate.recordedAnswer;
        assert.ok(answer,'Likely candidate missing saved model answer');
        const values={artist_name:row.artist||result.artist,tier:row.tier,
          profile_id:row.profile_id,cm_artist:row.cm_artist,instagram_url:url,
          likely_review_suggestion:true,score:answer.sameIdentityProbability??answer.score,
          verdict:answer.verdict,decision_reason:candidate.decision?.reason??candidate.review?.reason??candidate.reason,
          catalog_link_added:false,campaign_id:campaign,snapshot_utc:stamp};
        lines.push(columns.map(k=>csv(values[k])).join(',')+'\r\n');
      }
      return lines;
    }));
    count+=group.reduce((n,x)=>n+x.length,0);
    await handle.write(group.flat().join(''));
  }
} finally {await handle.close();}
const bytes=(await fs.stat(file)).size;
assert.ok(bytes<100*1024*1024);
const summary={artists:rows.length,urlRows:count,bytes,campaign,snapshotUtc:stamp,
  paidCalls:0,databaseWrites:0,note:'One likely Instagram URL per row. Review suggestions, not confirmed ownership or catalog additions. Large raw evidence payloads omitted.'};
await fs.writeFile(out+'/summary.json',JSON.stringify(summary,null,2),{flag:'wx'});
console.log(JSON.stringify(summary));
