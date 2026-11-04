---
name: Musician Instagram research
description: All eligible selected-tier musicians, snapshot freshness, and lookup identity requirements.
---

The musician Instagram research covers ALL musicians matching the user's selected tiers, including Tiers 4 and 5, not a 100-profile sample.

**Why:** The user corrected the initial sample: “i don't need 100 - i need ALL tier 3 artists/musicians man,” then requested the same research for Tiers 1, 2, 4, and 5.

**How to apply:** Retain the supplied current-day tier freshness filter, exclusion of any already-linked Instagram account, and monthly-listener prioritization, but do not add a total profile limit. Reuse completed Serper searches instead of charging again. This explicit name-based research cohort can include profiles without linked accounts; it does not change the general bulk tool's linked-account eligibility rule.

The saved Tier 1–3 Instagram research cohort contains profiles selected after excluding profiles with an existing Instagram catalog link. For coverage of this cohort, a current-tier profile with no saved research event is counted as already catalog-linked.

**Why:** Joining the full account catalog made the coverage query too expensive, while this cohort's selection rule already records which profiles had existing links.

**How to apply:** Use this complement only for this explicitly filtered Tier 1–3 research cohort. Do not infer a catalog link from missing research events in other workflows or cohorts.

Research results must be retrievable using the catalog profile ID, `cm_artist`, or an existing linked catalog account ID.

**Why:** The user explicitly requested these three lookup options.

**How to apply:** Preserve the distinct identifier namespaces and all associated account IDs. An artist without any linked account still supports profile-ID and `cm_artist` lookup. Keep discovered candidates separate from approved catalog links, and do not treat no candidates as proof of account absence.

Validate search-strategy changes against known existing accounts before scaling, and distinguish raw search hits from identity-supported artist candidates.

**Why:** A broader name-only validation still missed a user-supplied existing account while returning unrelated same-name Instagram accounts for other artists. More queries alone did not establish reliable recovery or identity matching.

**How to apply:** Keep supplied URLs out of blind discovery queries, retain unfiltered search evidence (including posts and topic pages) for diagnosis, and report raw-hit counts separately from plausible artist matches. Do not replace production outcomes with an unreviewed validation sample.

A failed artist-name search does not establish that an Instagram account is unindexed.

**Why:** Exact Instagram-path searches recovered a known account that multiple name-only searches missed; its indexed display name differed from its artist name.

**How to apply:** Discover handle clues from identity-linked reference sources, then use exact-path Serper checks. Clearly distinguish recovery using a supplied handle from independent name-based discovery; do not guess handles and call them confirmed.

Treat an empty current-day tier selection immediately after UTC midnight as a possible snapshot-refresh gap, not proof that the tier has no artists.

**Why:** The database day advanced before the next tier computation arrived; the latest completed musician snapshot still contained the expected population.

**How to apply:** Inspect snapshot timestamps before reporting an empty cohort. For an explicitly requested run, disclose and pin a recent completed snapshot, rejecting one older than 36 hours rather than silently selecting stale historical assignments. Keep ordinary current-day selection unchanged unless this alternative is explicitly chosen.

Reconcile a final saved-status snapshot before treating a completed worker's profile as unfinished.

**Why:** Multiple completed research batches initially reported one profile as still running even though all worker completions were logged; a fresh read then showed the final saved result without another provider call. The visibility delay's exact cause has not been established.

**How to apply:** Refresh the read-only status/report once after workers finish. Never repeat a paid search solely because the immediate aggregate still says running; investigate persistence if the discrepancy remains.
