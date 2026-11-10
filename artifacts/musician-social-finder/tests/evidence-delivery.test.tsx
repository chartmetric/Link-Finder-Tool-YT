import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvidenceDelivery } from '../src/components/evidence-delivery';

test('omissions are separate from a model hold and search attribution remains uncertain',()=>{
  const html = renderToStaticMarkup(<EvidenceDelivery delivery={{matchedPostRecords:7,retainedPostRecords:3,omittedPostRecords:4}} />);
  assert.match(html,/Incomplete post evidence delivery/);
  assert.match(html,/does not explain or change the saved model decision/);
  assert.match(html,/Search-snippet attribution is uncertain/);
  assert.match(html,/delivery-omitted">4</);
});

test('legacy and partial diagnostics never turn missing values into zeros',()=>{
  const legacy = renderToStaticMarkup(<EvidenceDelivery />);
  assert.equal((legacy.match(/Not recorded/g)??[]).length,3);
  assert.match(legacy,/Missing counts are unknown, not zero/);
  const partial = renderToStaticMarkup(<EvidenceDelivery delivery={{retainedPostRecords:0}} />);
  assert.match(partial,/delivery-retained">0</);
  assert.doesNotMatch(partial,/No matched post records were omitted/);
  const zero = renderToStaticMarkup(<EvidenceDelivery delivery={{matchedPostRecords:0,retainedPostRecords:0,omittedPostRecords:0}} />);
  assert.match(zero,/No matched post records were omitted/);
});

test('per-candidate scan limits and truncation are displayed with bounded-context caveats',()=>{
  const html = renderToStaticMarkup(<EvidenceDelivery delivery={{candidatePostDiagnostics:[{
    url:'https://www.instagram.com/example/',diagnostics:{availableEvidence:45,inspectedEvidence:40,
      uninspectedEvidence:5,truncatedEvidence:2,matchedRecords:8,retainedRecords:3,omittedRecords:5},
  }]}} />);
  assert.match(html,/Uninspected due to scan limit/);
  assert.match(html,/Truncated or skipped oversized evidence/);
  assert.match(html,/aggregate matched counts use the original context/);
  assert.match(html,/instagram.com\/example/);
});
