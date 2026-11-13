---
name: YouTube video discovery budget boundary
description: Why uploader resolution needs replacement slots rather than extra calls or reused test approval.
---

Video-to-uploader resolution is a new paid operation, not an extra channel
metadata call covered by a completed test's approval. Plan replacement slots
inside the existing call/spending caps before proposing execution.

**Why:** Saved video hits exposed a discovery gap, but resolving their uploaders
would consume operations that the direct-channel-only test never authorized.
Keeping the same dollar cap alone does not preserve the approved operation scope.

**How to apply:** Keep offline discovery prototypes separate from paid runners.
Require a fresh exact-scope approval and transactional per-operation allocation
before activation. Preserve alternatives and disclose any lost capture breadth.
Snippet handles and uploader identities remain discovery clues, never independent
artist ownership evidence, even when their names match.

An exact-request saved-case approval must not become a wildcard for live
discovery or its dependent requests.

**Why:** A new search or uploader result changes the channel identity and the
later ownership model's request body; approving only a call count cannot bind
those unknown requests to reviewed evidence.

**How to apply:** Freeze saved evidence and exact requests before asking for
exact-plan approval. If downstream inputs are not known, stop preparation or
seek a separately reviewed bounded dynamic-discovery policy rather than
silently filling approved slots with new identities.

Use separate approval stages for a saved-video recovery test when the uploader
is not yet known: approve only the frozen uploader requests first, then prepare
and approve exact channel/model requests after receiving those identities.

**Why:** This preserves exact-request approval without pretending an unknown
uploader or model input was already reviewed. The user requested an improved
test, not an open-ended spending policy.

**How to apply:** Preserve every resolved uploader alternative, clearly label
Topic leads and shared-channel uncertainty, and disclose the later capture
breadth/selection policy. Uploader resolution alone is discovery, not an
accepted artist-owned link or measured ownership recovery.

The live video endpoint can omit its top-level `url` even when the returned
video ID and uploader identities are valid.

**Why:** An actual paid response omitted that documented field, causing the
initial strict mapper to stop despite preserving a useful uploader response.

**How to apply:** Bind the exact frozen request and returned video ID; validate
an explicitly supplied URL against that ID, but do not require the optional
field. Keep missing or conflicting IDs, contradictory uploader identities,
unknown billing, and malformed explicit URLs as blocking failures. Never repeat
the paid request to fix a parser issue: validate its saved bytes offline and
require exact recovery approval before acknowledging it or dispatching an
updated sealed continuation. Preserve the original reservation.

The same endpoint can omit `channel.title` and put the display name in
`uploader.author` or `ownerByline.name`.

**Why:** A live Topic uploader response supplied consistent channel IDs but
only these alternative display-name fields, stopping a sealed continuation.

**How to apply:** Use only nonempty names attached to the already validated,
matching uploader/owner IDs. Never substitute video titles, recommendations,
or search snippets; the name still does not establish artist ownership.

Uploader URLs can contain percent-encoded accented handles, such as an encoded
`ï`. An unsupported URL representation is not evidence of a wrong artist.

**Why:** A live response had consistent video/uploader IDs but its accented
handle failed the mapper's URL normalizer after most of the stage completed.

**How to apply:** Report this as a parsing limitation, preserve the saved
response and reservation, and do not retry or count it as an ownership
rejection. Review Unicode URL normalization offline before changing a sealed
worker or preparing any separately approved continuation.

Keep acknowledgment of a saved paid response separate from permission to
dispatch the old run's untouched remainder or a new recovery cohort.

**Why:** A stopped uploader stage can contain many acknowledged returns, one
saved-but-unacknowledged response and untouched requests. Treating all of these
as a single restart would turn a bookkeeping repair into new paid work.

**How to apply:** Prepare a recovery-only proposal that binds the complete
admission history, original owner, raw receipt and unchanged reservations.
Require separate recovery approval and fresh locked revalidation. Keep the
source run stopped and exclude all new provider requests; later stages need
their own scope and spending approval.

Saved video benchmark text relevance must be reported separately from exact
catalog identity, uploader identity and artist ownership. Missing video-to-channel
bindings make ownership precision unscorable, not zero. Format words such as
lyrics or cover do not establish the uploader's role.

**Why:** A source-text review can identify recording credits and title collisions
without proving who uploaded the video. Counting text positives as owned-channel
recovery, or treating unknown uploaders as negative ownership labels, would
manufacture accuracy from absent evidence.

**How to apply:** Preserve unknown denominators, keep synthetic role controls out
of saved-sample metrics, and measure video-ID deferrals separately from direct
capture-slot losses. Without resolved uploader IDs and a defined selection
policy, only channel-diversity bounds and optimistic direct-retention ceilings
are justified.

Primary uploader-recovery deliverables must separate a small review shortlist
from the full raw uploader evidence. Neither is an ownership-approved import.

**Why:** The user repeatedly found promotional uploaders, broadcasters and
song-title collisions in raw uploader exports and requested a shared fix, not
only per-artist annotations.

**How to apply:** Hold unbound names and shared channels, preserve exact-pair
user rejections, retain clearly separated Topic leads, and require independent
ownership evidence after name triage. Keep all held evidence accessible without
describing it as a likely match or proving that an artist has no channel. A
stricter shortlist is a precision/recall tradeoff, not demonstrated accuracy.

When allocating bounded video-recovery slots, retain a supported
distribution/Topic lead instead of allowing ordinary upload videos to consume
every slot.

**Why:** The user found KAIVA's Topic presence with a simple search while the
direct-channel test left its link blank. Relevant saved video results existed;
discarding them and crowding out distributor leads concealed useful discovery.

**How to apply:** Replace an existing uploader slot rather than adding spending.
Treat the distributor credit as a discovery clue, not a captured Topic identity
or confirmed catalog association. Preserve deferred alternatives and disclose
that the slot policy trades ordinary-uploader breadth for Topic coverage.
