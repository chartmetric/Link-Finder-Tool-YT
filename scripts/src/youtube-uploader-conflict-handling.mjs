// Opt-in handling for fully saved, validly billed responses with contradictory
// uploader identities. This never selects an ID or authorizes a provider call.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {assertVideoStageApproval} from './youtube-video-stage.mjs';
import {mapSavedVideoUploader} from './youtube-video-uploader-review.mjs';
import {validateConflictResponse} from './youtube-uploader-conflict-recovery.mjs';

export const CONFLICT_HANDLING_FILE='evidence/conflict-handling-policy.json';
export const CONFLICT_HANDLING_SCOPE=Object.freeze({
  policy:'hold-known-uploader-identity-conflicts-v1',
  acknowledgeSavedValidResponse:true,continueUntouchedRequests:true,
  selectConflictingChannel:false,approveOwnership:false,retryRequest:false,
  stopOnMalformedOrUnknownBilling:true,
});
export function uploaderConflictHandlingApproval(plan,approval){
  assertVideoStageApproval(plan,approval);
  assert.equal(plan.evidenceFiles[CONFLICT_HANDLING_FILE],digest(JSON.stringify(CONFLICT_HANDLING_SCOPE)),
    'Conflict handling must be explicitly bound to the newly approved plan');
  return {policy:CONFLICT_HANDLING_SCOPE.policy,planSha256:digest(plan),
    stageApprovalSha256:digest(approval),holdConflicts:true,selectChannel:false,retry:false};
}
export function mapOrHoldSavedUploader(artist,clue,receipt,context,{holdConflicts=false}={}){
  try{return {kind:'resolved',result:mapSavedVideoUploader(artist,clue,receipt,context)};}
  catch(error){
    // Do not catch HTTP failures, missing names/IDs, bad video bindings,
    // unsupported URLs, unknown billing or arbitrary assertion errors.
    if(!holdConflicts||error.code!=='ERR_ASSERTION'
      ||!error.message.startsWith('Conflicting or incomplete provider uploader identity'))throw error;
    const review=validateConflictResponse({...clue.operation,profileId:artist.profileId,
      cmArtist:artist.cmArtist,videoId:clue.videoId,inputSha256:digest(clue.operation.request)},
    receipt,receipt.rawBody);
    const {rawBody,...savedReceipt}=receipt;
    return {kind:'held_conflict',result:{resultKind:'held_conflict',
      profileId:artist.profileId,cmArtist:artist.cmArtist,operationKey:receipt.operationKey,
      videoUrl:clue.url,...review,verified:false,ownershipEvidence:false,
      rawReceipt:{runId:context.runId,planSha256:context.planSha256,
        rawPath:receipt.rawPath,rawBodySha256:receipt.rawBodySha256,
        receiptSha256:digest(savedReceipt)}}};
  }
}
