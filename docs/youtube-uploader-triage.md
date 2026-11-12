# YouTube uploader false-positive investigation

## Finding

Video relevance and artist-channel ownership are different questions. The saved
search accepted artist-name mentions in recording titles, snippets, and
recommendations. Its role check could not distinguish ordinary promotional
uploaders from artists. The stage then exported every mapped uploader as raw
discovery evidence, including rows explicitly labeled different/unknown.
Although none was accepted or cataloged, this was not a useful artist-channel
shortlist.

Midnight Plus illustrates both problems: one snippet calls the phrase a track;
another describes an AI song. Their uploaders are Driving Dark and Music Px
Official. Other reviewed errors are KRACHPILOT's promotional uploaders and
张碧晨's ZJSTV uploaders.

## Shared changes

- Future video request planning requires a recognizable performer credit,
  rather than an artist phrase anywhere in a snippet. Explicit song-description,
  AI-song and conflicting distribution-credit cases are held. Evidence remains
  available; these are not definitive wrong-identity verdicts.
- Uploader triage uses exact catalog-bound names/aliases, not search mentions.
  Different/unknown uploaders and shared channels are held separately.
- Matching names produce **review candidates only**, never acceptance, import
  eligibility or automatic authorization for downstream paid calls.
- Topic names are evaluated separately, clearly labeled auto-generated leads,
  and still require independent artist-association evidence.
- Explicit user rejections bind the complete profile, catalog artist and channel
  tuple, not a channel globally.
- New stage exports put unique review-candidate artist/channel pairs in
  `video-uploader-findings.csv`. The complete raw observations and holds remain
  in `video-uploader-discovery-evidence.csv`.

This is a precision-first filter. It can hold a genuine channel with a different,
uncaptured alias. A hold must not become a finding that the artist has no channel.
The rule does not replace the separately approved ownership check.

## Saved-sample result

Offline replay of 37 mapped video responses:

- 8 ordinary name-matching observations and 1 matching Topic observation:
  deduplicated into **6 channels for 5 artists**.
- 22 held observations: 20 unbound uploaders and 2 unbound Topic leads.
- 6 user-rejected observations.
- **0 accepted artist-owned links; 0 import-eligible links.**

This is triage, not a measured ownership-accuracy improvement. Only the six
user-rejected observations have that negative review; held cases remain unknown.

The replay validates saved raw-response hashes and original request/artist
bindings, fingerprints the source archive before and after, and creates outputs
outside it. No provider calls, coordinator changes, catalog writes, frozen-worker
edits, campaign restarts, or historical counter changes occur.
