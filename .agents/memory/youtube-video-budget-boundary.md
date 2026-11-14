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

Keep execution permission as a separate approval supplement; do not enable or
replace an already reviewed offline preparation approval.

**Why:** Later stages bind the original approval object and exact receipt bytes.
Changing that object to enable dispatch would invalidate the evidence chain and
could make an old preparation approval appear to authorize new spending.

**How to apply:** Bind the unchanged preparation plan/approval and a separately
sealed executor to fresh explicit execution approval. Preserve the original
approval in downstream returns, and use the supplement only for transactional
execution admission.

Exact-request hashes are not sufficient for identity-stage non-replay: keep
independent kind-scoped exclusions for profile, Chartmetric artist and channel.

**Why:** A changed channel/request or a different profile can evade a combined
identity tuple even though one of the already reserved identities is reused.
The boundary protects each identity, not merely identical outgoing bytes.

**How to apply:** Check each exclusion transactionally across run IDs and back
it with independent uniqueness constraints. Preserve failed/uncertain
reservations. Repeated selected-channel allocations must stop before spending,
not silently substitute another channel or inherit fresh permission.

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

Use a distinct fresh-stage policy when changing cohort size; keep historical
twenty-artist plans and recovery approvals valid under their original rules.

**Why:** A smaller saved-video fallback should not weaken an earlier exact
twenty-artist authorization or accidentally inherit its remaining allowance.

**How to apply:** Freeze the smaller cohort, requests and runtime under a new
plan fingerprint and approval, retaining the existing per-artist limits,
non-replay coordinator and independent downstream-identity boundary.
For larger batches, prefer a separately approved aggregate of unchanged
fixed-size stages over making legacy plan sizes or allowances variable.
Bind every child fingerprint and the summed ceiling in the aggregate approval.
This preserves historical recovery validation and prevents a larger batch from
quietly widening each child's operation authority.

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

A single video response can mix a Topic uploader's channel ID and URL with
a different Official Artist Channel ID in the owner byline and channel object.

**Why:** A live response credited the requested artist on a collaboration
while the uploader and owner byline named another artist, with contradictory
channel IDs. Majority agreement among fields would conceal the conflict.

**How to apply:** Keep such a response unresolved and preserve its reservation
and raw bytes. Do not infer alias equivalence, pick one ID by majority vote,
or retry the video request. Any recovery acknowledgment and continuation need
separate exact approval; a co-credit does not establish channel ownership.

Acknowledging a conflicting saved response records transport receipt only,
not a resolved uploader or a successful artist match.

**Why:** A stopped stage can contain a fully saved, billed HTTP success that
cannot safely map to one channel. Requiring a fabricated channel to reconcile
that receipt would undermine the false-positive safeguards.

**How to apply:** Bind the original owner, every completed receipt, the one
conflict and the exact untouched suffix to a separately approved continuation.
Preserve prior charges; leave the conflict with no selected channel and no
import eligibility. Validate the full prefix/suffix partition and combined
original cap. Never weaken legacy recovery validators to accommodate a new
cohort or treat receipt acknowledgment as permission to repeat that request.

New exact execution plans can explicitly opt into holding known uploader-ID
conflicts and continuing untouched requests, instead of stopping the whole test.

**Why:** Topic and Official Artist Channel identities can be mixed in provider
responses. Requiring a separate stop/recovery for each known ambiguity repeatedly
interrupts the test without adding identity certainty.

**How to apply:** Bind this policy to fresh plan and runtime hashes and separate
execution approval; never enable it inside an already sealed worker. Save and
acknowledge only fully validated responses with known billing and exact video
bindings. Keep conflicting channel IDs unselected and out of every channel CSV,
count held responses separately, and never retry them. Missing IDs, bad video
bindings, provider failures, malformed responses and unknown billing still stop
dispatch. Preserve original receipts and cumulative reservations.

Mixed direct-search and uploader verification must bind both original sources,
including acknowledged recovery receipts, rather than inventing a single
completed uploader archive or treating a handle as a known channel ID.

**Why:** Useful direct channel leads can exist without video-uploader observations;
a fully accounted split test can also retain honestly stopped historical stages.
The old single-completed-stage preparation contract does not describe that case.

**How to apply:** Preserve the old archives and their states, independently
reconcile all saved charges, and require a fresh exact capture scope. Unknown
handles remain URL targets until captured metadata proves the canonical ID.
Check those returned aliases against current and historical artist claims.
Preparation must stay read-only even if the identity coordinator was never
installed; install missing coordination only inside separately approved execution.

Prioritize capturing a usable direct channel lead before paying to resolve all
associated video uploaders. Keep video fallbacks for artists without a usable
direct lead; never count those deferred artists as completed no-matches.

**Why:** Video results often identify collaborators, distributors or promotional
uploaders, while the stricter direct-channel sample received positive user
review. Direct-first routing reduces unnecessary paid discovery without
pretending that name agreement proves artist ownership.

**How to apply:** Direct-only captures need a distinct exact source policy bound
to saved search receipts and catalog identities. Do not fabricate uploader
observations or relax an older mixed-source recovery contract. Screen shared
claims across the entire cohort and historical sources, retain Topic labels and
deferred alternatives, and separately approve any later uploader fallback.

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
