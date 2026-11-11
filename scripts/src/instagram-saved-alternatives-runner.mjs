// Saved candidates only. No discovery, catalog writes, imports or auto-resume.
import {digest,enrichedRequest,validateSavedAlternativeScope} from './instagram-next-saved-batch.mjs';
import {catalogBoundReviewSuggestion,savedCandidateInspection} from './instagram-likely-review-policy.mjs';

export async function runSavedAlternatives({scope,gate,persist,previousArtists=null}){
  scope=structuredClone(scope);
  validateSavedAlternativeScope(scope);
  const scopeSha256=digest(scope);
  if(typeof persist!=='function')throw Error('A durable output writer is required.');
  const captures=new Map(),shared=new Map();
  for(const t of scope.targets)for(const c of t.candidates){
    if(!shared.has(c.url))shared.set(c.url,new Set());
    shared.get(c.url).add(String(t.profileId));
  }
  let artists=scope.targets.map(t=>({artist:t.artist,profileId:t.profileId,cmArtist:t.player.cm_artist,
    status:t.candidates.length?'uninspected':'no_saved_candidate',
    candidates:t.candidates.map(c=>({...c,status:'uninspected',reason:'not_inspected_within_approved_run'})),
    verified:false,liveLinkAccepted:false}));
  const completedProfiles=new Set();
  if(previousArtists){
    if(!Array.isArray(previousArtists)||previousArtists.length!==artists.length)
      throw Error('Continuation requires the complete frozen artist snapshot.');
    for(let i=0;i<artists.length;i++){
      const old=previousArtists[i],expected=artists[i];
      if(old.profileId!==expected.profileId||old.cmArtist!==expected.cmArtist||old.artist!==expected.artist
        ||digest(old.candidates.map(c=>c.url))!==digest(expected.candidates.map(c=>c.url)))
        throw Error('Archived continuation artists do not match the frozen scope.');
      if(old.candidates[0]?.status!=='uninspected')completedProfiles.add(old.profileId);
      for(const c of old.candidates)if(c.metadata){
        if(c.metadata.available&&c.metadata.candidate?.url!==c.url)
          throw Error('Archived metadata is not bound to its candidate.');
        captures.set(c.url,structuredClone(c.metadata));
      }
    }
    artists=structuredClone(previousArtists);
  }
  const eligible=scope.targets.map(t=>t.candidates.length>0);
  let stopReason=null,budgetExhausted=false,current=null;
  const affordable=()=>{
    const s=gate.snapshot();
    if(s.stopped)throw Error('Parent gate is stopped; no further admissions.');
    if(s.maximumSpendCents!==scope.authorization.maxSpendCents||s.budgetId!==scope.authorization.budgetId
      ||s.scopeSha256!==scopeSha256)
      throw Error('Parent gate does not match the frozen approval.');
    if(s.reservedCents+2>s.maximumSpendCents){budgetExhausted=true;return false;}
    return true;
  };
  const checkpoint=()=>persist({artists:structuredClone(artists),budget:gate.snapshot()});
  try{
    // Finish each first-candidate turn before any second-candidate turn.
    const rounds=scope.inspectSavedAlternatives?Math.max(...scope.targets.map(t=>t.candidates.length)):1;
    outer:for(let round=0;round<rounds;round++){
      for(let i=0;i<scope.targets.length;i++){
        const t=scope.targets[i],artist=artists[i],c=artist.candidates[round];
        if(!eligible[i]||!c||completedProfiles.has(t.profileId))continue;
        current=null;
        let metadata=captures.get(c.url);
        if(!metadata){
          if(!affordable())break outer;
          current=c;
          metadata=await gate.request({kind:'scrapecreators_candidate',profileId:t.profileId,url:c.url});
          if(typeof metadata.available!=='boolean'||(metadata.available&&metadata.candidate?.url!==c.url))
            throw Error('Metadata receipt is not bound to the exact account.');
          captures.set(c.url,structuredClone(metadata));
        }
        current=c;
        c.metadata=structuredClone(metadata);
        if(!metadata.available){
          c.status='unavailable';c.reason=metadata.reason??'completed_metadata_unavailable';
          artist.status=c.status;
          await checkpoint();current=null;continue;
        }
        c.status='inconclusive';c.reason='metadata_captured_verification_not_inspected';
        artist.status=c.status;
        await checkpoint();
        let built;
        try{built=enrichedRequest({...t,selected:c},metadata.candidate);}
        catch{
          c.status='unsupported';c.reason='complete_evidence_does_not_fit_supported_request';
          artist.status=c.status;eligible[i]=false;
          await checkpoint();current=null;continue;
        }
        if(!affordable()){c.reason='parent_budget_exhausted_before_verification';break outer;}
        const response=await gate.request({kind:'jev',profileId:t.profileId,url:c.url});
        if(response.unavailable){
          c.status='unavailable';c.reason='acknowledged_verifier_failure_not_retried';
        }else{
          if(response.model!==scope.expectedModel)throw Error('Resolved verifier model changed; no retry.');
          const profile={...built.profile,jevVerification:response.answers?.[0]};
          const decision=catalogBoundReviewSuggestion(profile,t.player,{
            sharedHandle:shared.get(c.url).size>1,
            guardPolicy:'targeted_title_guard',modelState:built.body.state});
          const inspection=savedCandidateInspection(decision);
          c.status=inspection.status;c.reason=decision.reason;c.review=decision;
          c.recordedAnswer=response.answers?.[0]??null;c.requestSha256=built.sha256;
          eligible[i]=inspection.tryAlternative;
        }
        artist.status=c.status;
        await checkpoint();current=null;
      }
    }
  }catch(error){
    stopReason=error.message;
    if(current){
      current.status='inconclusive';current.reason='interrupted_or_uncertain_no_retry';
      const artist=artists.find(a=>a.candidates.includes(current));artist.status='inconclusive';
    }
  }finally{
    // Closing dispatch is essential even when local evidence/output handling fails.
    gate.stop();
  }
  const result={status:stopReason?'stopped':'completed',stopReason,budgetExhausted,artists,
    budget:gate.snapshot(),newSearches:0,newPublicPageFetches:0,liveLinkChanges:0,
    interpretation:'Saved alternatives only, in round-robin order. Review suggestions are not verified ownership. Uninspected or unavailable evidence does not prove no account exists.'};
  await persist(structuredClone(result));
  return result;
}
