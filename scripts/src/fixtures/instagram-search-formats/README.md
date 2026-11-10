# Instagram search formatting corpus

Run offline with:

```sh
node --test scripts/src/instagram-post-signals.test.mjs
```

`v1.json` is a scrubbed collection of **saved Serper organic results**, not
fetched Instagram posts or reviewed ownership labels. Its source map retains
the local archive path, JSON pointer, observation time and original-hit digest.
Tests need only the committed JSON; ignored archives are optional provenance,
never a runtime dependency. The digest encoding is specified in the collection.

`observed` preserves source formatting while replacing identities, post IDs and
caption content with neutral examples. Dates are source claims, not verified
publication dates. Locale query parameters do not prove the language or
ownership of a result. Localized `op`, `no`, fullwidth-comma and Japanese
date/engagement formats deliberately stay unconfirmed; this corpus does not
authorize a broader multilingual owner parser.

`derived` contains explicit adversarial mutations of those saved examples.
There was no unambiguous coauthor header or conflicting URL/header pair in the
selected saved sources. Joint caption mentions are observed, but are **not**
proof of coauthorship. Coauthor header, caption-injection, title-injection and
URL/header-disagreement tests are labeled mutations, not invented real captures.
No provider calls or archived decision edits are needed to extend the suite.

For updates, use only already-saved evidence or user-supplied examples. Preserve
syntax and delimiters while scrubbing identifiers/content; retain provenance
and document transformations. Add new immutable `vN.json` versions for source
format changes and bump `schemaVersion` only if the collection structure changes.
Keep unsupported formats negative until separately reviewed; never treat a
new fixture or a search-snippet attribution as artist ownership adjudication.
