import assert from 'node:assert/strict';
export const HOLD_CHANNEL_CONFLICTS='hold-channel-identity-conflicts-v1';
export function identityConflict(claims){
  assert.ok(Array.isArray(claims)&&claims.length);
  const error=new Error('New catalog or historical shared-channel claim; prepare a new plan');
  error.code='YOUTUBE_IDENTITY_CONFLICT';
  error.claims=structuredClone(claims);
  return error;
}
export async function inspectIdentityConflict(action,enabled){
  try{await action();return [];}catch(error){
    if(!enabled||error.code!=='YOUTUBE_IDENTITY_CONFLICT'||!Array.isArray(error.claims)||!error.claims.length)throw error;
    return structuredClone(error.claims);
  }
}
