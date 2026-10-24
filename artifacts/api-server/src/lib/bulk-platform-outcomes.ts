import type { BulkPlatformOutcome, ProfileSearchResponse } from "@workspace/api-zod";

const platforms = ["Instagram", "TikTok", "YouTube"] as const;

/** An absence claim must be an explicit self-statement from the trusted profile.
 * Search snippets and missing results cannot prove nonexistence. */
export function explicitAbsenceStatement(text: string, platform: string) {
  const escaped = platform.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\bwe\\s+(?:are\\s+not|aren['’]t)\\s+on\\s+${escaped}\\b`, "i"),
    new RegExp(`\\bwe\\s+(?:do\\s+not|don['’]t)\\s+(?:have|operate|maintain|use)\\s+(?:(?:an?|any|official|our)\\s+){0,3}${escaped}\\s+(?:accounts?|profiles?)\\b`, "i"),
    new RegExp(`\\bour\\s+(?:only\\s+)?official\\s+accounts?\\s+(?:do\\s+not|does\\s+not)\\s+include\\s+${escaped}\\b`, "i"),
  ];
  // Quoted/search-indexed text and "not on X yet, but..." aren't conclusive.
  const sentences = text.split(/[\n.!?]+/).map(s => s.trim());
  return sentences.find(sentence => sentence.length < 500
    && !/\b(?:if|rumou?r|claimed|said|previously|formerly|but|however)\b|["“”]/i.test(sentence)
    && patterns.some(pattern => pattern.test(sentence)));
}

export function derivePlatformOutcomes(result: ProfileSearchResponse, referencePlatform: string): BulkPlatformOutcome[] {
  const checkedAt = new Date().toISOString();
  const reference = result.referenceProfile;
  const discoveryComplete = ["serper", "gemini"].every(method =>
    result.methodsUsed.some(item => item.method === method && item.status === "used"));
  return platforms.map(platform => {
    const base = { platform, checkedAt, evidenceUrls: [] as string[] };
    if (platform.toLowerCase() === referencePlatform.toLowerCase()) return {
      ...base, status: "reference" as const,
      reason: "This is the existing linked account used as the identity reference.",
      evidenceUrls: reference?.urlAliases ?? (reference?.url ? [reference.url] : []),
    };
    const candidates = result.profiles.filter(p => p.platform.toLowerCase() === platform.toLowerCase());
    const accepted = candidates.filter(p => p.jevVerification
      ? ["verified", "likely"].includes(p.jevVerification.verdict)
      : p.identityComparison?.status === "likely");
    if (accepted.length) return {
      ...base, status: "found" as const,
      reason: "At least one candidate has a likely or verified identity assessment. This is not automatic approval.",
      evidenceUrls: [...new Set(accepted.flatMap(p => p.urlAliases ?? [p.url]))],
    };
    const unresolved = candidates.filter(p => p.jevVerification
      ? p.jevVerification.verdict !== "mismatch"
      : p.identityComparison?.status !== "mismatch");
    if (unresolved.length) return {
      ...base, status: "needs_review" as const,
      reason: "Candidates exist but the evidence does not establish a likely identity match. Review before claiming a link or its absence.",
      evidenceUrls: [...new Set(unresolved.flatMap(p => p.urlAliases ?? [p.url]))],
    };
    const statement = reference && reference.platform !== "web"
      ? explicitAbsenceStatement(reference.bio ?? "", platform) : undefined;
    if (statement) return {
      ...base, status: "explicit_unavailable" as const,
      reason: `The trusted reference profile explicitly states: “${statement}”. This records that statement at check time, not a guarantee that no account can ever exist.`,
      evidenceUrls: [reference!.url],
    };
    return {
      ...base, status: discoveryComplete ? "not_found" as const : "incomplete" as const,
      reason: discoveryComplete
        ? "Both discovery providers completed without a supported identity match. No account found is not proof that no account exists."
        : "One or more required discovery providers failed or were unavailable. Account availability is unknown.",
      evidenceUrls: candidates.map(p => p.url),
    };
  });
}
