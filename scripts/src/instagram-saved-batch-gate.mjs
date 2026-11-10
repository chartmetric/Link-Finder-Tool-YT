// Separate, explicitly approved saved-evidence batches. Never resets the pilot.
import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
const sha=v=>createHash('sha256').update(v).digest('hex');
export async function connectSavedBatchPool(){
  const {default:pg}=await import('pg');
  return new pg.Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,max:2});
}
export const savedBatchSchemaSql=`
CREATE TABLE IF NOT EXISTS instagram_saved_batch_budgets (
 id text PRIMARY KEY, scope_sha256 text NOT NULL,
 cap_cents integer NOT NULL CHECK(cap_cents BETWEEN 1 AND 2000),
 reserved_cents integer NOT NULL DEFAULT 0 CHECK(reserved_cents>=0 AND reserved_cents<=cap_cents),
 owner uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS instagram_saved_batch_admissions (
 budget_id text NOT NULL REFERENCES instagram_saved_batch_budgets(id),
 admission_key text NOT NULL, profile_id text NOT NULL, cents integer NOT NULL CHECK(cents=2),
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(budget_id,admission_key)
);`;

export async function openSavedBatchGate({pool,scope,scopeSha256,journalPath,transport}){
  scope=structuredClone(scope);
  const cap=scope.authorization?.maxSpendCents;
  if(sha(JSON.stringify(scope))!==scopeSha256||scope.authorization?.approved!==true
    ||!Number.isInteger(cap)||cap<1||cap>2000||scope.artists.length>500||scope.requests.length>1000
    ||scope.requests.length*2>cap
    ||scope.savedEvidenceOnly!==true||scope.liveLinkWrites!==false||scope.automaticRetries!==0
    ||transport?.live!==true)throw Error('Invalid separate saved-batch authorization.');
  const requests=new Map(scope.requests.map(r=>[r.key,r]));
  if(requests.size!==scope.requests.length)throw Error('Duplicate frozen request key.');
  const artists=new Set(scope.artists.map(a=>String(a.profile_id)));
  for(const r of requests.values()){
    if(!artists.has(String(r.profileId))||r.kind!=='jev'||r.bytes>6000||r.bytes<1
      ||sha(JSON.stringify(r.body))!==r.sha256||Buffer.byteLength(JSON.stringify(r.body))!==r.bytes)
      throw Error('Unbound or oversized saved request.');
  }
  const owner=randomUUID(),id=scope.authorization.budgetId;
  const journal=await fs.open(journalPath,'wx');
  let stopped=false,active=false,admitted=0,returned=0,lastReserved=0,reportedCost=0;
  const append=async row=>{await journal.write(JSON.stringify({...row,at:new Date().toISOString()})+'\n');await journal.sync();};
  async function transaction(work){
    const c=await pool.connect();
    try{
      await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");await c.query("SET LOCAL statement_timeout='10s'");
      const {rows}=await c.query('SELECT * FROM instagram_saved_batch_budgets WHERE id=$1 FOR UPDATE',[id]);
      const b=rows[0];
      if(!b||b.scope_sha256!==scopeSha256||b.cap_cents!==cap)throw Error('Saved-batch approval is missing or changed.');
      const result=await work(c,b);await c.query('COMMIT');return result;
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  }
  try{
    await transaction(async(c,b)=>{
      if(b.owner||b.reserved_cents!==0)throw Error('Saved batch already claimed; automatic replay forbidden.');
      await c.query('UPDATE instagram_saved_batch_budgets SET owner=$2 WHERE id=$1',[id,owner]);
    });
  }catch(e){await journal.close();throw e;}
  return {
    async request(key){
      if(stopped||active)throw Error('Saved-batch gate stopped or already dispatching.');
      const r=requests.get(key);if(!r)throw Error('Request is outside approved saved scope.');
      active=true;let timer,controller;
      try{
        const text=JSON.stringify(r.body);
        if(sha(text)!==r.sha256)throw Error('Frozen request changed.');
        await transaction(async(c,b)=>{
          if(b.owner!==owner||b.reserved_cents+2>b.cap_cents)throw Error('Saved-batch ownership lost or cap reached.');
          await c.query('INSERT INTO instagram_saved_batch_admissions (budget_id,admission_key,profile_id,cents) VALUES ($1,$2,$3,$4)',
            [id,key,String(r.profileId),2]);
          await c.query('UPDATE instagram_saved_batch_budgets SET reserved_cents=reserved_cents+2 WHERE id=$1',[id]);
          lastReserved=b.reserved_cents+2;
        });
        // A failed journal or unknown COMMIT still consumes its reservation.
        await append({phase:'admitted',key,profileId:r.profileId,reservedCents:2});admitted++;
        controller=new AbortController();
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{
          stopped=true;controller.abort();reject(Error('Timed-out request is uncertain; no retry.'));
        },25000);});
        const result=await Promise.race([transport.dispatch({kind:'jev',key,
          payload:{body:r.body,inputSha256:r.sha256},signal:controller.signal}),timeout]);
        if(!Number.isFinite(result.cost)||result.cost<0||result.cost>0.02)throw Error('Unknown or excessive reported cost.');
        reportedCost+=result.cost;returned++;
        await append({phase:'returned',key,reportedCost:result.cost});
        return result;
      }catch(e){stopped=true;await append({phase:'stopped_no_retry',key}).catch(()=>{});throw e;}
      finally{clearTimeout(timer);active=false;}
    },
    stop(){stopped=true;},
    snapshot:()=>({budgetId:id,admitted,returned,reservedCents:lastReserved,reportedCostUsd:reportedCost,
      maximumSpendCents:cap,stopped,originalPilotModified:false}),
    close:async()=>{stopped=true;await journal.close();},
  };
}
