// Offline evaluator metadata only. No collection, provider, database or verifier calls.
import assert from 'node:assert/strict';

export const isTimestamp=value=>typeof value==='string'&&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===
    value.replace(/Z$/,value.includes('.')?'Z':'.000Z');
const text=value=>typeof value==='string'&&value.trim().length>0;

export function validateFreshness(labels,validateProof) {
  const f=labels.freshness;
  assert.equal(f?.version,1,'Explicit freshness metadata required');
  assert.equal(f.defaultStatus,'historical_only');
  assert.equal(f.automaticRefreshAllowed,false);
  assert.equal(f.newCollectionRequiresScopeAndSpendingApproval,true);
  assert.ok(Array.isArray(f.reviews));
  const ids=new Set(),latest=new Map();
  for(const r of f.reviews) {
    assert.ok(text(r.id)&&!ids.has(r.id),'Review ID must be unique');ids.add(r.id);
    const original=labels.cases.find(c=>c.id===r.caseId);
    assert.ok(original,'Review must reference an original case');
    assert.equal(r.supersedes,latest.get(r.caseId)?.id??null,'Review must explicitly supersede the latest review');
    assert.ok(isTimestamp(r.reviewedAt)&&text(r.reviewer)&&text(r.reason),'Review attribution, time and reason required');
    const prior=latest.get(r.caseId);
    assert.ok(!prior||Date.parse(r.reviewedAt)>=Date.parse(prior.reviewedAt),'Review history must be chronological');
    assert.ok(['stale','re_adjudicated'].includes(r.action),'Unknown freshness review action');
    if(r.action==='stale') {
      assert.ok(!('adjudication' in r)&&!('validUntil' in r),'Staleness cannot relabel an identity or renew proof');
    } else {
      assert.ok(isTimestamp(r.validUntil)&&Date.parse(r.validUntil)>Date.parse(r.reviewedAt),
        'Re-adjudication requires an explicit future expiry');
      assert.ok(text(r.validityReason),'Explain the chosen validity window; no automatic TTL');
      const a=r.adjudication;
      assert.ok(a&&Array.isArray(a.evidenceIds),'Re-adjudication requires source proof');
      validateProof({...original,expectedArtistOwned:a.expectedArtistOwned,stratum:a.stratum,evidenceIds:a.evidenceIds});
      for(const id of a.evidenceIds) {
        const e=labels.evidence[id];
        assert.ok(Date.parse(e.observedAt)<=Date.parse(r.reviewedAt),'Review cannot use future observations');
        if(!original.evidenceIds.includes(id)) {
          // Re-review of an existing archive is allowed, but is not new collection.
          assert.ok(['existing_archive','new_collection'].includes(e.acquisition?.kind),
            'New evidence must declare archive reuse or separately approved collection');
          if(e.acquisition.kind==='existing_archive') {
            assert.ok(text(e.acquisition.archiveReference),'Existing archive reference required');
          } else {
            const p=e.acquisition.approval;
            assert.ok(text(p?.scopeReference)&&text(p?.spendingReference)&&
              isTimestamp(p?.approvedAt)&&Number.isFinite(p?.maxSpendUsd)&&p.maxSpendUsd>=0,
            'New collection requires separate scope and spending approval, including zero-cost reads');
            assert.ok(Date.parse(p.approvedAt)<=Date.parse(e.observedAt),'Approval must predate collection');
          }
        }
      }
    }
    latest.set(r.caseId,r);
  }
}

export function ownershipFreshness(labels,c,{asOf=new Date().toISOString()}={}) {
  assert.ok(isTimestamp(asOf),'Freshness asOf must be an explicit UTC timestamp');
  const reviews=labels.freshness.reviews.filter(r=>r.caseId===c.id&&Date.parse(r.reviewedAt)<=Date.parse(asOf));
  const review=reviews.at(-1);
  const status=!review?'historical_only':review.action==='stale'?'stale':
    Date.parse(asOf)>=Date.parse(review.validUntil)?'expired':'current';
  return {asOf,status,reviewId:review?.id??null,validUntil:review?.validUntil??null,
    reason:review?.reason??'Original observation only; current ownership has not been re-adjudicated.',
    currentAdjudication:status==='current'?structuredClone(review.adjudication):null,
    requiresReAdjudication:status!=='current'};
}

// Append-only proposal. Caller saves a new file; original source object is never modified.
export function appendOwnershipReview(labels,{review,evidence={}},validate) {
  const next=structuredClone(labels);
  for(const [id,item] of Object.entries(evidence)) {
    assert.ok(!Object.hasOwn(next.evidence,id),'Evidence IDs are immutable; append a new ID');
    assert.ok(review.adjudication?.evidenceIds?.includes(id),'Appended evidence must be used by this review');
    next.evidence[id]=structuredClone(item);
  }
  next.freshness.reviews.push(structuredClone(review));
  validate(next);
  return next;
}
