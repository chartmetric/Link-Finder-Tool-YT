import assert from "node:assert/strict";
import { test } from "node:test";
import { getNetConfidence } from "../../musician-social-finder/src/lib/net-confidence.ts";

type Input = Parameters<typeof getNetConfidence>[0];
const metadata = { platform: "instagram", handle: "example", url: "https://www.instagram.com/example/" };
function example(overrides: Partial<Input> = {}): Input {
  return {
    confidence: 71,
    identityComparison: { status: "mismatch", score: 10, reasons: [], reference: metadata, candidate: metadata },
    jevVerification: { verdict: "mismatch", sameIdentityProbability: 0.42, verdictConfidence: 0.23, probabilities: {} },
    ...overrides,
  };
}

test("the screenshot's 71 discovery / 10 identity / 42% JEV produces 38% net confidence", () => {
  const net = getNetConfidence(example());
  assert.equal(net.score, 38);
  assert.equal(net.status, "complete");
  assert.match(net.explanation, /20%.*30%.*50%/);
  assert.match(net.explanation, /not a calibrated probability/);
});

test("a JEV mismatch cannot become a high net score even with high discovery and identity scores", () => {
  const input = example({ confidence: 100 });
  input.identityComparison!.score = 100;
  input.jevVerification!.sameIdentityProbability = 1;
  assert.equal(getNetConfidence(input).score, 49);
  assert.match(getNetConfidence(input).explanation, /caps net confidence at 49%/);
});

test("strong consistent verification can produce a high net score", () => {
  const input = example({ confidence: 90 });
  input.identityComparison = { ...input.identityComparison!, status: "likely", score: 90 };
  input.jevVerification = { ...input.jevVerification!, verdict: "verified", sameIdentityProbability: 0.95 };
  assert.equal(getNetConfidence(input).score, 93);
});

test("missing JEV is explicitly partial and uses the disclosed 20/80 weighting", () => {
  const net = getNetConfidence(example({ jevVerification: undefined }));
  assert.equal(net.score, 22);
  assert.equal(net.status, "partial");
  assert.match(net.explanation, /JEV is unavailable/);
});

test("JEV-only identity evidence is partial rather than pretending metadata comparison exists", () => {
  const net = getNetConfidence(example({ identityComparison: undefined }));
  assert.equal(net.score, 48);
  assert.equal(net.status, "partial");
  assert.match(net.explanation, /identity comparison is unavailable/);
});

test("discovery alone never masquerades as net identity confidence", () => {
  const net = getNetConfidence({ confidence: 99 });
  assert.equal(net.score, null);
  assert.equal(net.status, "unassessed");
});

test("confidence in the chosen JEV label is not treated as positive identity probability", () => {
  const first = example();
  const second = example();
  second.jevVerification!.verdictConfidence = 0.99;
  assert.equal(getNetConfidence(first).score, getNetConfidence(second).score);
});

test("zero is valid evidence; out-of-range and invalid numbers never escape score bounds", () => {
  const zero = example({ confidence: 0 });
  zero.identityComparison!.score = 0;
  zero.jevVerification!.sameIdentityProbability = 0;
  assert.equal(getNetConfidence(zero).score, 0);
  const extreme = example({ confidence: 900 });
  extreme.identityComparison!.score = -50;
  extreme.jevVerification!.sameIdentityProbability = 5;
  const net = getNetConfidence(extreme);
  assert.ok(net.score !== null && net.score >= 0 && net.score <= 100);
  assert.equal(getNetConfidence({ confidence: NaN }).score, null);
});
