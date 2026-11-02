import type { BulkBrandItem, BulkPlatformOutcome } from '@workspace/api-client-react';

type Presentation = { label: string; tone: string; description: string };
const supportedPlatforms = ['instagram', 'tiktok', 'youtube'];

export function platformSearchStatus(outcome: BulkPlatformOutcome): Presentation {
  switch (outcome.status) {
    case 'incomplete': return {
      label: 'Search incomplete', tone: 'incomplete',
      description: 'Search failed or was unavailable. Whether an account exists is unknown.',
    };
    case 'not_found': return {
      label: 'No supported match', tone: 'not_found',
      description: 'Search finished without a supported match. This does not confirm that no account exists.',
    };
    case 'explicit_unavailable': return outcome.evidenceUrls.some(url => /^https?:\/\//i.test(url)) ? {
      label: 'No account reported', tone: 'explicit_unavailable',
      description: 'The trusted profile explicitly reports no account on this platform. See the source below.',
    } : {
      label: 'Absence unverified', tone: 'needs_review',
      description: 'No valid source is attached to this absence claim. Whether an account exists is unknown.',
    };
    case 'needs_review': return {
      label: 'Needs review', tone: 'needs_review',
      description: 'Possible accounts were found, but identity evidence is inconclusive.',
    };
    case 'reference': return {
      label: 'Reference account', tone: 'reference',
      description: 'Existing linked account used as the identity reference.',
    };
    case 'found': return {
      label: 'Match found', tone: 'found',
      description: 'A likely or verified identity match was found. Review the evidence before accepting.',
    };
  }
}

/** Queue completion is not evidence that every platform search succeeded.
 * Derive presentation only; never change saved job states or retry eligibility. */
export function profileSearchStatus(item: Pick<BulkBrandItem, 'status' | 'platforms'>): Presentation {
  if (item.status === 'queued') return { label: 'Queued', tone: 'queued', description: 'Waiting in the server queue.' };
  if (item.status === 'running') return { label: 'Searching', tone: 'running', description: 'Searches are still in progress.' };
  if (item.status === 'failed') return { label: 'Job failed', tone: 'failed', description: 'Processing failed. Search results may be incomplete; see the error details.' };

  const missing = supportedPlatforms.filter(platform => !item.platforms.some(o => o.platform.toLowerCase() === platform));
  const incomplete = item.platforms.filter(o => o.status === 'incomplete');
  if (missing.length || incomplete.length) {
    const partial = item.platforms.some(o => o.status !== 'incomplete' && o.status !== 'reference');
    return {
      label: partial ? 'Partial results' : 'Search incomplete', tone: partial ? 'partial' : 'incomplete',
      description: `Processing finished, but ${[...incomplete.map(o => o.platform), ...missing.map(p => p === 'youtube' ? 'YouTube' : p === 'tiktok' ? 'TikTok' : 'Instagram')].join(', ')} ${missing.length + incomplete.length === 1 ? 'is' : 'are'} unresolved because searches did not complete or have no saved assessment. This is not evidence of absence.`,
    };
  }
  if (item.platforms.some(o => platformSearchStatus(o).tone === 'needs_review')) return {
    label: 'Needs review', tone: 'needs_review', description: 'Processing finished, but some platform evidence remains inconclusive.',
  };
  if (item.platforms.some(o => o.status === 'not_found')) return {
    label: item.platforms.every(o => o.status === 'not_found' || o.status === 'reference') ? 'No supported matches' : 'Search finished',
    tone: 'finished', description: 'Searches finished. Platforms with no supported match are not confirmed absent.',
  };
  if (item.platforms.some(o => o.status === 'found')) return {
    label: 'Links found', tone: 'completed', description: 'Matching candidates found. Review identity evidence before accepting.',
  };
  return {
    label: 'Resolved with sources', tone: 'reported',
    description: 'Each supported platform has an existing reference account or a sourced first-party no-account statement.',
  };
}
