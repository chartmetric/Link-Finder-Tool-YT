import React from 'react';
import type { VerificationContextDelivery } from '@workspace/api-client-react';

const count = (n: number | undefined) => n === undefined ? 'Not recorded' : n.toLocaleString();

/** Display saved audit data only. Never infer omissions from a model verdict. */
export function EvidenceDelivery({ delivery }: { delivery?: VerificationContextDelivery }) {
  const omitted = delivery?.omittedPostRecords;
  const complete = delivery?.matchedPostRecords !== undefined
    && delivery.retainedPostRecords !== undefined && omitted !== undefined;
  return (
    <section className="inv-delivery" aria-label="Saved verification evidence delivery" data-testid="section-evidence-delivery">
      <h3>Post evidence delivery</h3>
      <p>Saved request-fitting diagnostics, separate from the model’s verdict. No new lookup or verification was run.</p>
      <dl className="inv-delivery-counts">
        <div><dt>Matched post records</dt><dd data-testid="delivery-matched">{count(delivery?.matchedPostRecords)}</dd></div>
        <div><dt>Retained for verification</dt><dd data-testid="delivery-retained">{count(delivery?.retainedPostRecords)}</dd></div>
        <div><dt>Omitted before verification</dt><dd data-testid="delivery-omitted">{count(omitted)}</dd></div>
      </dl>
      <p className="inv-delivery-status" data-testid="delivery-status">
        {omitted !== undefined && omitted > 0
          ? 'Incomplete post evidence delivery: matched records were omitted while fitting the verification request. This does not explain or change the saved model decision.'
          : complete
            ? 'No matched post records were omitted in the saved delivery audit. This does not establish complete discovery, ownership, or model acceptance.'
            : 'Post delivery diagnostics were not fully recorded for this result. Missing counts are unknown, not zero; evidence delivery cannot be inferred from a model hold.'}
      </p>
      <p>Search-snippet attribution is uncertain, not a newly fetched post or proof of account ownership. Release-title matches are consistency clues only; snippet dates are source claims and may be unknown.</p>
      {!!delivery?.candidatePostDiagnostics?.length && (
        <details className="inv-delivery-candidates">
          <summary>Per-candidate scan and truncation details</summary>
          <p>These saved bounded-scan counts may exclude uninspected evidence. Per-candidate matches use the retained context; aggregate matched counts use the original context before request fitting.</p>
          {delivery.candidatePostDiagnostics.map(({ url, diagnostics: d }, i) => (
            <div className="inv-delivery-candidate" key={`${url}-${i}`}>
              <h4>{url}</h4>
              <dl>
                <div><dt>Available search evidence</dt><dd>{count(d.availableEvidence)}</dd></div>
                <div><dt>Inspected evidence</dt><dd>{count(d.inspectedEvidence)}</dd></div>
                <div><dt>Uninspected due to scan limit</dt><dd>{count(d.uninspectedEvidence)}</dd></div>
                <div><dt>Truncated or skipped oversized evidence</dt><dd>{count(d.truncatedEvidence)}</dd></div>
                <div><dt>Matched records in retained context</dt><dd>{count(d.matchedRecords)}</dd></div>
                <div><dt>Retained post records</dt><dd>{count(d.retainedRecords)}</dd></div>
                <div><dt>Omitted by per-candidate record limit</dt><dd>{count(d.omittedRecords)}</dd></div>
              </dl>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
