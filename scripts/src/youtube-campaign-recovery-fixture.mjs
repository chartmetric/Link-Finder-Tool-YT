// Test-only SQL double. Unknown statements fail; no real database is reachable.
import assert from 'node:assert/strict';
export function isolatedRecoveryPool(initial){
  let state=structuredClone(initial),backup=null;
  const queries=[],failures=[];
  const rows=items=>({rows:structuredClone(items),rowCount:items.length});
  const pool={queries,failures,get state(){return state;},async connect(){return {query:pool.query,release(){}};},
    async query(sql,args=[]){
      const q=sql.replace(/\s+/g,' ').trim();queries.push(q);
      try{
        if(q==='BEGIN'){assert.equal(backup,null);backup=structuredClone(state);return rows([]);}
        if(q==='COMMIT'){backup=null;return rows([]);}
        if(q==='ROLLBACK'){state=backup;backup=null;return rows([]);}
        assert.equal(args[0],state.campaign.id);
        if(q.startsWith('SELECT * FROM youtube_link_campaigns '))return rows([state.campaign]);
        if(q.startsWith('SELECT * FROM youtube_link_campaign_artists ')){
          if(q.includes("status IN ('queued','in_progress','failed')"))
            return rows(state.artists.filter(a=>['queued','in_progress','failed'].includes(a.status)).slice(0,20));
          return rows(args[1]?state.artists.filter(a=>a.profile_id===args[1]):state.artists);
        }
        if(q.startsWith('SELECT * FROM youtube_link_campaign_admissions '))return rows(state.admissions);
        if(q.startsWith('SELECT count(*)::int n FROM youtube_link_campaign_admissions '))
          return rows([{n:state.admissions.filter(a=>a.status==='admitted').length}]);
        if(q.startsWith('SELECT * FROM youtube_link_campaign_channels '))return rows(state.channels);
        if(q.startsWith('SELECT profile_id FROM youtube_link_campaign_channels '))
          return rows(state.channels.filter(a=>a.channel_id===args[1]&&a.profile_id!==args[2]));
        if(q.startsWith('SELECT * FROM youtube_link_campaign_recoveries '))
          return rows(args[1]?state.claims.filter(c=>c.owner===args[1]):state.claims);
        if(q.startsWith('INSERT INTO youtube_link_campaign_recoveries ')){
          const old=state.claims.find(c=>c.prior_owner===args[1]);
          const next={prior_owner:args[1],owner:args[2],plan_sha256:args[3],status:args[4],approval:args[5]};
          if(old){assert.equal(old.owner,next.owner);assert.equal(old.plan_sha256,next.plan_sha256);Object.assign(old,next);}
          else state.claims.push(next);
          return rows([next]);
        }
        if(q.startsWith('INSERT INTO youtube_link_campaign_channels')){
          if(!state.channels.some(c=>c.channel_id===args[1]&&c.profile_id===args[2]))
            state.channels.push({campaign_id:args[0],channel_id:args[1],profile_id:args[2]});
          return rows([]);
        }
        if(q.startsWith('INSERT INTO youtube_link_campaign_admissions')){
          assert.ok(!state.admissions.some(a=>a.operation_key===args[1]));
          state.admissions.push({campaign_id:args[0],operation_key:args[1],profile_id:args[2],
            kind:args[3],input_sha256:args[4],reserved_cents:2,status:'admitted'});
          return rows([]);
        }
        if(q.startsWith('UPDATE youtube_link_campaign_admissions SET')){
          const a=state.admissions.find(a=>a.operation_key===args[1]&&a.input_sha256===args[2]&&a.status==='admitted');
          if(!a)return rows([]);
          Object.assign(a,{status:'returned',receipt_sha256:args[3],http_status:args[4]});return rows([a]);
        }
        if(q.startsWith('UPDATE youtube_link_campaigns SET')){
          if(q.includes('owner=$2'))state.campaign.owner=args[1];
          if(q.includes("status='running'"))state.campaign.status='running';
          if(q.includes("status='completed'"))state.campaign.status='completed';
          if(q.includes("status='stopped'"))state.campaign.status='stopped';
          if(q.includes('reserved_cents=reserved_cents+2'))state.campaign.reserved_cents=String(Number(state.campaign.reserved_cents)+2);
          return rows([state.campaign]);
        }
        if(q.startsWith('UPDATE youtube_link_campaign_recoveries SET')){
          const c=state.claims.find(c=>c.owner===args[1]);
          c.status=q.includes("'completed'")?'completed':'stopped';return rows([c]);
        }
        if(q.startsWith('UPDATE youtube_link_campaign_artists')){
          if(q.includes('youtube_discovery_test_results'))return rows([]);
          if(q.includes('EXISTS(')){
            for(const a of state.artists)if(state.channels.some(x=>x.profile_id===a.profile_id&&
              state.channels.some(y=>y.channel_id===x.channel_id&&y.profile_id!==x.profile_id)))
              Object.assign(a,{likely:false,reason:'channel_reused_across_catalog_artists'});
            return rows([]);
          }
          const a=state.artists.find(a=>a.profile_id===args[1]);assert.ok(a);
          if(q.includes("SET status='in_progress'"))a.status='in_progress';
          else if(q.includes("SET status='completed'"))
            Object.assign(a,{status:'completed',searched:args[2],checked:args[3],likely:args[4],candidates:args[5],result_sha256:args[6],reason:null});
          else if(q.includes("SET status='failed'"))a.status='failed';
          else if(q.includes("SET status='deferred'"))Object.assign(a,{status:'deferred',reason:'current_catalog_eligibility_or_identity_changed'});
          else if(q.includes('SET likely=false'))Object.assign(a,{likely:false,reason:'channel_reused_across_catalog_artists'});
          else assert.fail('Unrecognized artist update: '+q);
          return rows([a]);
        }
        assert.fail('Unexpected SQL in isolated test: '+q);
      }catch(e){failures.push(e);throw e;}
    }};
  return pool;
}
