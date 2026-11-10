import type { ArtistResultBatch } from '@workspace/api-client-react';

export function alternativesObservation(batch: ArtistResultBatch) {
  if (batch.source !== 'diagnostic') return null;
  const metric = (label: string) => batch.metrics?.find(m => m.label === label)?.value;
  const structured = batch.observation;
  if (structured !== undefined) {
    // A malformed explicit identity must not silently regroup using older prose.
    if (!structured || !/^[a-f0-9]{24}$/.test(structured.scopeIdentity)
      || !/^[a-f0-9]{16}$/.test(structured.checkpointIdentity)
      || typeof structured.parentBudgetId !== 'string' || !structured.parentBudgetId.trim()
      || !['final', 'checkpoint'].includes(structured.kind)) return null;
    return {
      scope: structured.scopeIdentity, checkpoint: structured.checkpointIdentity,
      parentBudget: structured.parentBudgetId, kind: structured.kind,
      runKey: JSON.stringify([structured.scopeIdentity, structured.parentBudgetId]),
      spending: metric('Spending observation'), dateSource: metric('Run date source'),
    };
  }
  // Immutable older imports have no structured metadata. Preserve their exact
  // identity and conservative provenance rules without rewriting the archive.
  const identity = /^saved-alternatives-([a-f0-9]{24})-([a-f0-9]{16})$/.exec(batch.id);
  if (!identity) return null;
  const recordedParent = metric('Parent budget identity');
  const parentBudget = recordedParent?.trim() ? recordedParent : undefined;
  const spending = metric('Spending observation');
  // A final file can describe a stopped run. Status and createdAt do not establish
  // finality or chronology: createdAt is normally the first admission in the run.
  const kind = spending === 'Final saved parent snapshot, not an invoice' ? 'final'
    : spending?.startsWith('Last durable parent snapshot;') ? 'checkpoint' : 'unknown';
  return {
    scope: identity[1], checkpoint: identity[2], parentBudget, spending, kind,
    runKey: parentBudget ? JSON.stringify([identity[1], parentBudget]) : null,
    dateSource: metric('Run date source'),
  };
}

export function groupObservations(batches: ArtistResultBatch[]) {
  const groups: { key: string; batches: ArtistResultBatch[] }[] = [];
  const runs = new Map<string, (typeof groups)[number]>();
  for (const batch of batches) {
    const runKey = alternativesObservation(batch)?.runKey;
    let group = runKey ? runs.get(runKey) : undefined;
    if (!group) {
      group = { key: runKey ?? batch.id, batches: [] };
      groups.push(group);
      if (runKey) runs.set(runKey, group);
    }
    group.batches.push(batch);
  }
  return groups;
}
