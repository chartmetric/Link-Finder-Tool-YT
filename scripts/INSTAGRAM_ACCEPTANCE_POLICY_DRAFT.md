# Draft: accepting musician Instagram matches

**Status: proposal only — not approved, implemented or enabled.**

This draft changes no current decision, threshold, coverage count, export or stored link.
It authorizes no searches, paid tests, imports or full reruns.

## Goal

Recognize real artist accounts without accepting another artist, label, festival,
brand, venue or fan account simply because it shares a name or promotes the music.
An official account managed by the artist's team can represent the artist; an
organization's account that merely represents or promotes many artists cannot.

We do **not** need to know an artist's correct Instagram account beforehand.
Known-answer examples are for evaluating the checker, not supplying its answers.

## Proposed decision routes

| Evidence | Proposed outcome |
|---|---|
| Independently trusted artist website explicitly connects the exact musician and Instagram account; JEV says verified; no contradictions | **Source-confirmed research match**, under the new route below |
| An exact, source-bound music connection and JEV verified with identity score at least 0.90; existing safeguards pass | **Supported research match**, retaining the current route |
| A plausible candidate without enough ownership evidence, or inconclusive verification | **Unresolved** — save evidence, but do not accept the attribution |
| Evidence identifies another person, label, brand, festival, venue or fan account | **Rejected attribution** — not proof the artist has no Instagram |
| A completed, adequate search yields no supported account | **No supported match** — not proof of absence |
| Failed/incomplete search, missing starting metadata or confirmed restriction | **Failed/incomplete/skipped**, as appropriate — never absence |

Neither “source-confirmed” nor “supported” means a catalog link has been approved.

## Route 1: source-confirmed research match

All of the following must hold.

### 1. The website is independently trusted

Establish that the site represents this artist through a source independent of
the candidate Instagram account and the website's own assertions. Examples:

- A music or video account already bound to this catalog artist links to the site.
- An established artist-specific label or management directory establishes the
  artist's domain and identity, with the supporting relationship documented.

A search result, matching domain name, platform badge, Instagram-to-website loop,
or a website containing both links is **not sufficient by itself** to establish
website ownership. A website found through research is a candidate source until
its artist relationship is established.

Do not count two pages copied from the same source as independent confirmation.

### 2. The page connects the exact artist and account

- The relevant artist page explicitly links the candidate Instagram account and
  the exact catalog-bound music identity, such as the correct Spotify artist ID.
- Both links belong to the same artist-specific context, not a publisher's global
  footer, embedded recommendation, advertisement or promoted creator list.
- A release URL is not an artist ID. Resolve its credits without selecting a
  convenient track or ignoring other artists, deleted records or compilations.
- Preserve the source chain. Website links must never be relabeled as links
  observed directly on Spotify or in the Instagram biography.
- Only a direct account URL qualifies. A post, reel, mention or tag can supply a
  discovery clue but cannot itself establish an artist-owned account.

### 3. Ownership is consistent

The account's self-identification is consistent with the artist and there is no
material competing-entity explanation, contradictory source or unresolved shared
handle claim.

Sharing music is not ownership. A related entity fails this route even when it
links the correct artist's music. A group account must not automatically be
assigned to each member's separate artist profile.

### 4. Verification supports the attribution

JEV must return **verified** for the exact target artist/account pair. A mismatch,
likely or uncertain result cannot pass this route automatically.
Either route also requires a valid, finite identity score within [0, 1]; missing
or malformed verification cannot pass.

**Proposed policy difference:** once the source gates above are satisfied, the
blanket 0.90 numeric requirement would not be the sole acceptance gate for this
source-confirmed route. The identity score would still be retained and examined
for contradictions. This is a deliberate conditional policy change, not something
already approved by the recent tests.

No substitute numeric cutoff is selected in this draft. Contradictory categorical
and numeric answers must be held; an explicit, tested disagreement rule is required
before this route can be enabled. Confidence in the *verified label* must never
be substituted for the separate identity score.

## Route 2: retain the current supported-match requirements

For cases without qualifying trusted website evidence, retain:

- Safe account URLs and metadata bound to the exact candidate and catalog reference.
- An exact, source-bound music cross-link.
- A likely identity comparison, JEV verified, and a finite identity score of at
  least **0.90** and at most 1.
- Existing mismatch, related-entity and conflicting-duplicate safeguards.

Names, badges, follower counts, search rank and a high discovery score cannot
replace these requirements. Missing evidence remains unresolved rather than
being converted into a mismatch or absence claim.

## Contradictions and source changes

- Preserve significant handle characters, including underscores. Removing tracking
  parameters must not merge different accounts.
- Hold unresolved artist/profile collisions. Documented aliases or duplicate
  identities must be distinguished from different artists sharing an account.
- Keep conflicting observations; do not promote an account by choosing only the
  best-scoring occurrence or retrying until a favorable answer appears.
- Recheck source links and account identity before ingestion and after a source or
  handle change. An explicit freshness policy must be approved before automation.
- A restricted account can be skipped only when the response establishes a
  restriction; an HTTP status alone is not enough.

## Research results and live ingestion stay separate

For every decision, retain the artist/profile/account lookup identities, original
and normalized URLs, source context, timestamps, source hashes, exact music IDs,
model/version, actual verifier input, verdict, identity score, policy version and
reason. Do not record credentials or cookies.

If later approved for live ingestion, submit link claims through
**`account_links/claims.record`**, then let **resolve** process them.
Never write discovered links directly into live account/profile-link tables.
Unresolved, rejected, restricted and failed cases are not eligible artist-link
claims under this policy.

Coverage must distinguish source-confirmed/supported links, unresolved candidates,
completed no-matches and failed/skipped work. A research match is not an approved
catalog link, and the proposed route must not silently reclassify historical data.

## What must happen before this proposal can go live

1. Approve the source-trust, freshness and verifier-disagreement rules explicitly.
   This draft leaves them as activation requirements, not implicit defaults.
2. Implement source-aware website evidence without falsifying existing music-profile
   metadata or weakening related-entity and collision checks.
3. Evaluate a larger, independently adjudicated, held-out set, including impersonators,
   fan sites, publisher footers, shared releases and shared handles. Keep expected
   answers outside verifier inputs and report unique artists/accounts separately
   from repeated comparisons.
4. Agree on acceptable missed-positive and wrong-acceptance rates **before** using
   test outcomes to choose policy settings. Do not claim safety from zero wrong
   acceptances in a tiny sample that accepts no correct accounts either.
5. Obtain approval for a bounded shadow pilot with no imports. Revalidate whenever
   model, evidence extraction or policy changes.
6. Approve any production activation and claims submission separately, with spending
   caps, stop conditions and an auditable policy/version record.

## How the recent examples fit

- **Frankelly:** a regression example, never a special-case exception. A music link
  alone does not establish a trusted artist-website-to-Instagram route.
- **Aimee, ERNEST and The Format:** their reviewed pages improved JEV's answers to
  verified, but the current 0.90 requirement still held them. Those selected pages
  are useful evidence examples, not automatic certification of the proposed website
  trust rules or population accuracy.
- **Shenge:** the user's correct-account assertion is a test label, not a fabricated
  music cross-link. Without qualifying source evidence, the missing prerequisite
  remains visible.

**Bottom line:** propose an explicit route for demonstrably trusted source evidence;
do not lower confidence requirements globally or treat a small test as rollout approval.
