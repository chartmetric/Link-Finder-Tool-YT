// Local queueing and connection management only; no provider or policy imports.
import assert from 'node:assert/strict';

export const COORDINATOR_OPTIONS=Object.freeze({
  max:8,connectionTimeoutMillis:60000,idleTimeoutMillis:30000,
});
export async function openCoordinatorPool(){
  const {default:pg}=await import('pg');
  return new pg.Pool({connectionString:process.env.DATABASE_URL,...COORDINATOR_OPTIONS});
}
export function coordinatorTransactions(pool,{maximumPending=512}={}){
  assert.ok(Number.isInteger(maximumPending)&&maximumPending>=1&&maximumPending<=1024);
  let tail=Promise.resolve(),pending=0;
  return async fn=>{
    // Each transaction already takes the same campaign row lock. Queue before
    // acquiring a connection instead of filling the database pool with waiters.
    assert.ok(pending<maximumPending,'Coordinator queue capacity reached; no dispatch.');
    pending++;
    const result=tail.then(async()=>{
      const c=await pool.connect();
      try{
        await c.query('BEGIN');
        await c.query("SET LOCAL lock_timeout='5s'");
        await c.query("SET LOCAL statement_timeout='30s'");
        const value=await fn(c);
        await c.query('COMMIT');
        return value;
      }catch(e){
        await c.query('ROLLBACK').catch(()=>{});
        throw e;
      }finally{c.release();}
    });
    tail=result.catch(()=>{});
    try{return await result;}finally{pending--;}
  };
}
