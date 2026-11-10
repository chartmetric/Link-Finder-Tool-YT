// For newly constructed requests, not historical ablation replays.
// Resolution status, album binding and unknown ownership are source evidence.
export function withoutWorkflowJudgments(request) {
  const clean=structuredClone(request);
  for(const candidate of clean.state.candidates) {
    delete candidate.identityComparisonStatus;
    delete candidate.identityComparisonReasons;
  }
  return clean;
}
