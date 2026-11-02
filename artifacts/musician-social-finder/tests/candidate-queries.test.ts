// Run from the workspace root:
// pnpm --filter @workspace/api-server exec esbuild ../musician-social-finder/tests/candidate-queries.test.ts --bundle --platform=node --format=esm --outfile=.local/test-build/candidate-queries.test.js
// node --test artifacts/api-server/.local/test-build/candidate-queries.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  getListBulkBrandCandidatesQueryKey, getListBulkBrandCandidatesQueryOptions,
  type ListBulkBrandCandidatesParams, type BulkBrandCandidates,
} from '@workspace/api-client-react';

function deferred() {
  let resolve!: (data: BulkBrandCandidates) => void;
  const promise = new Promise<BulkBrandCandidates>(r => { resolve = r; });
  return { promise, resolve };
}
function page(id: number, profileType: 'brand' | 'creator' | 'artist'): BulkBrandCandidates {
  return {
    profiles: [{ profileId: id, profileName: profileType, profileType, tier: 2, tierRank: id,
      accountId: String(id), platform: 'instagram', handle: profileType, url: `https://instagram.com/${profileType}/` }],
    hasMore: true, nextAfterId: id, maxBatchSize: 25,
  };
}

test('every candidate filter and pagination dimension has a separate generated cache key', () => {
  const params: ListBulkBrandCandidatesParams = { limit: 10, afterId: 0, profileType: 'brand' };
  const variants = [params, { ...params, profileType: 'creator' }, { ...params, profileType: 'artist' },
    { ...params, limit: 25 }, { ...params, afterId: 42 }, { ...params, search: 'alice' }, { ...params, tier: 2 }];
  assert.equal(new Set(variants.map(p => JSON.stringify(getListBulkBrandCandidatesQueryKey(p as ListBulkBrandCandidatesParams)))).size, variants.length);
});

test('late responses after rapid type, search, tier and page changes cannot populate current rows', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const changes: ListBulkBrandCandidatesParams[] = [
    { profileType: 'brand', limit: 10, afterId: 0 },
    { profileType: 'creator', limit: 10, afterId: 0 },
    { profileType: 'artist', limit: 10, afterId: 0 },
    { profileType: 'artist', limit: 10, afterId: 0, search: 'alice' },
    { profileType: 'artist', limit: 10, afterId: 0, search: 'alice', tier: 2 },
    { profileType: 'artist', limit: 10, afterId: 42, search: 'alice', tier: 2 },
  ];
  const gates = changes.map(() => deferred());
  const options = (i: number) => getListBulkBrandCandidatesQueryOptions(changes[i], { query: {
    queryKey: getListBulkBrandCandidatesQueryKey(changes[i]), staleTime: 30_000,
    // Ignore cancellation deliberately to exercise an actual late response.
    queryFn: () => gates[i].promise,
  } });
  const observer = new QueryObserver(client, options(0));
  const unsubscribe = observer.subscribe(() => {});
  try {
    gates[0].resolve(page(1, 'brand'));
    await client.getQueryCache().find({ queryKey: options(0).queryKey })!.promise;
    assert.equal(observer.getCurrentResult().data?.profiles[0].profileType, 'brand');
    for (let i = 1; i < changes.length; i++) {
      observer.setOptions(options(i));
      assert.equal(observer.getCurrentResult().data, undefined, `No previous rows on change ${i}`);
    }
    // Resolve old cohorts and old filters while the current page is still pending.
    for (let i = 1; i < changes.length - 1; i++) {
      gates[i].resolve(page(i + 1, changes[i].profileType!));
      await client.getQueryCache().find({ queryKey: options(i).queryKey })!.promise;
      assert.equal(observer.getCurrentResult().data, undefined);
    }
    gates.at(-1)!.resolve(page(99, 'artist'));
    await client.getQueryCache().find({ queryKey: options(changes.length - 1).queryKey })!.promise;
    assert.equal(observer.getCurrentResult().data?.profiles[0].profileId, 99);
    observer.setOptions(options(0));
    assert.equal(observer.getCurrentResult().data?.profiles[0].profileType, 'brand');
  } finally { unsubscribe(); client.clear(); }
});

test('a failed new filter has no previous rows and can recover to a genuine empty page', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const previous: ListBulkBrandCandidatesParams = { profileType: 'creator', limit: 10, afterId: 0 };
  client.setQueryData(getListBulkBrandCandidatesQueryKey(previous), page(1, 'creator'));
  const next = { ...previous, search: 'missing', tier: 5 };
  let fails = true;
  const options = getListBulkBrandCandidatesQueryOptions(next, { query: {
    queryKey: getListBulkBrandCandidatesQueryKey(next),
    queryFn: async () => {
      if (fails) throw new Error('catalog unavailable');
      return { profiles: [], hasMore: false, nextAfterId: 0, maxBatchSize: 25 };
    },
  } });
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    assert.equal(observer.getCurrentResult().isError, true);
    assert.equal(observer.getCurrentResult().data, undefined);
    fails = false;
    await observer.refetch();
    assert.equal(observer.getCurrentResult().isSuccess, true);
    assert.deepEqual(observer.getCurrentResult().data?.profiles, []);
  } finally { unsubscribe(); client.clear(); }
});
