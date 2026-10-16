import type { ProfileMatch } from "@workspace/api-client-react";

type ConfidenceInput = Pick<ProfileMatch, "confidence" | "identityComparison" | "jevVerification">;
type ConfidenceResult = {
  score: number | null;
  status: "complete" | "partial" | "unassessed";
  explanation: string;
};

const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number) => Math.max(0, Math.min(100, value));

/**
 * A transparent evidence score, NOT a calibrated identity probability.
 * Calculate from stored evidence too, so old investigations use the same rules.
 * Verdict confidence measures certainty about a label, not positive identity
 * support; use JEV's same-identity probability rather than that label confidence.
 */
export function getNetConfidence(candidate: ConfidenceInput): ConfidenceResult {
  const discovery = clamp(valid(candidate.confidence) ? candidate.confidence : 0);
  const identity = candidate.identityComparison?.score;
  const jevProbability = candidate.jevVerification?.sameIdentityProbability;
  const hasIdentity = valid(identity);
  const hasJev = valid(jevProbability);
  if (!hasIdentity && !hasJev) return {
    score: null,
    status: "unassessed",
    explanation: "Net confidence is not assessed: no readable identity comparison or JEV same-identity probability. The discovery score alone is not identity confidence.",
  };

  let score: number;
  let explanation: string;
  if (hasIdentity && hasJev) {
    score = 0.2 * discovery + 0.3 * clamp(identity) + 0.5 * clamp(jevProbability * 100);
    explanation = `20% × discovery (${discovery}/100) + 30% × identity (${clamp(identity)}/100) + 50% × JEV same identity (${clamp(jevProbability * 100).toFixed(1)}%).`;
  } else if (hasIdentity) {
    score = 0.2 * discovery + 0.8 * clamp(identity);
    explanation = `Partial assessment: JEV is unavailable. 20% × discovery (${discovery}/100) + 80% × identity (${clamp(identity)}/100).`;
  } else {
    score = 0.2 * discovery + 0.8 * clamp(jevProbability! * 100);
    explanation = `Partial assessment: identity comparison is unavailable. 20% × discovery (${discovery}/100) + 80% × JEV same identity (${clamp(jevProbability! * 100).toFixed(1)}%).`;
  }
  if (hasJev && candidate.jevVerification?.verdict === "mismatch") {
    score = Math.min(score, 49);
    explanation += " JEV mismatch caps net confidence at 49%.";
  }
  return {
    score: Math.round(clamp(score)),
    status: hasIdentity && hasJev ? "complete" : "partial",
    explanation: `${explanation} Combined evidence score, not a calibrated probability or automatic approval.`,
  };
}
