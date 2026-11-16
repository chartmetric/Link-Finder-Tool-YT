import assert from 'node:assert/strict';
// A catalog SELECT is not a paid discovery/metadata operation. Retry only a
// positively identified HTTP 408, once, with identical SQL. Never return an
// empty fallback or catch an identity/eligibility rejection.
export async function catalogReadWithOneTimeoutRetry(query,sql){
  assert.match(sql.trim(),/^SELECT\b/i);
  try{return await query(sql);}
  catch(error){
    if(error?.message!=='Catalog metadata HTTP 408; no retry.')throw error;
    return query(sql);
  }
}
