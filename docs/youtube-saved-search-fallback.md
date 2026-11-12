# Saved-search video fallback

The direct-channel test can return useful videos but no direct channel URLs.
That is a discovery gap, not evidence that the artist has no channel.

`prepare-youtube-saved-fallback.mjs` reads a completed test's saved search
receipts for artists with no direct captures. It validates the source plan,
approval hash, artist bindings, exact search request, response status and receipt
bytes. It preserves all video evidence and marks eligible, held and deferred
results separately, without importing a transport or database client.

The shared planner recognizes exact collaboration performer credits and bounded
`Main Artist:` credits in distributor snippets. When available, one of the two
uploader proposal slots retains a distribution/Topic lead. This replaces a slot;
it never increases the two-video ceiling. A distributor snippet is not proof of
the uploader, channel type or exact catalog artist association.

For KAIVA, this retains the saved `Too Rich` distribution lead while excluding
the similarly named film and the differently credited KAIVA VE OAPA results.

```sh
node scripts/src/prepare-youtube-saved-fallback.mjs \
  generated-artifacts/youtube-test-20-precision-2026-11-12 \
  generated-artifacts/youtube-saved-fallback-2026-11-12
```

Outputs are a non-executable proposal and a full evidence CSV. Preparation never
inherits the completed test's spending approval, acknowledges a response, checks
live eligibility, reserves money, performs provider calls, or writes catalog
links. Proposed costs are conservative uploader-only reservations, not billed
amounts or the total cost of later channel/identity checks.

Before any execution, a new sealed executable plan must recheck current catalog
eligibility and transactional non-replay/uncertain-admission state, including
old uploader stages. Exact uploader requests need separate approval. Subsequent
channel and identity requests require another preparation and approval once the
uploader identities are known.

After resolution, use shared uploader triage to exclude exact user-rejected
pairs, hold shared or unbound uploaders, label Topic leads, and keep every result
unaccepted until independent identity evidence supports the association.
No existing sealed runtime or archived result is edited by these source changes.
