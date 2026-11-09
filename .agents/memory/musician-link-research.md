---
name: Musician Instagram research
description: All eligible selected-tier musicians, snapshot freshness, and lookup identity requirements.
---

The musician Instagram research covers ALL musicians matching the user's selected tiers, including Tiers 4 and 5, not a 100-profile sample.

**Why:** The user corrected the initial sample: “i don't need 100 - i need ALL tier 3 artists/musicians man,” then requested the same research for Tiers 1, 2, 4, and 5.

**How to apply:** Retain the supplied current-day tier freshness filter, exclusion of any already-linked Instagram account, and monthly-listener prioritization, but do not add a total profile limit. Reuse completed Serper searches instead of charging again. This explicit name-based research cohort can include profiles without linked accounts; it does not change the general bulk tool's linked-account eligibility rule.

Do not infer an existing Instagram catalog link merely because a profile has no saved research event.

**Why:** That shortcut depended on an earlier no-link cohort selection and ceased being a reliable coverage rule as tier populations and research scopes changed.

**How to apply:** Require actual catalog-link evidence, and distinguish raw search candidates from identity-supported artist URLs when explaining coverage.

Research results must be retrievable using the catalog profile ID, `cm_artist`, or an existing linked catalog account ID.

**Why:** The user explicitly requested these three lookup options.

**How to apply:** Preserve the distinct identifier namespaces and all associated account IDs. An artist without any linked account still supports profile-ID and `cm_artist` lookup. Keep discovered candidates separate from approved catalog links, and do not treat no candidates as proof of account absence.

Live Instagram ingestion must use link claims through `account_links/claims.record` and the normal resolver, never direct live account or profile-link table writes.

**Why:** The user explicitly requires claim resolution before live links are created; reported false positives show that a successful search is not sufficient identity evidence.

**How to apply:** Preserve discovery provenance and unresolved status in engineer handoffs. Identity-supported research candidates still need claim resolution and are not approved catalog links.

Validate search-strategy changes against known existing accounts before scaling, and distinguish raw search hits from identity-supported artist candidates.

**Why:** A broader name-only validation still missed a user-supplied existing account while returning unrelated same-name Instagram accounts for other artists. More queries alone did not establish reliable recovery or identity matching.

**How to apply:** Keep supplied URLs out of blind discovery queries, retain unfiltered search evidence (including posts and topic pages) for diagnosis, and report raw-hit counts separately from plausible artist matches. Do not replace production outcomes with an unreviewed validation sample.

Frankelly Bello's user-confirmed Instagram handle is `frankellybello_`; Serper's `belloo_official` result is unrelated, and the saved `Frankellybello` result without the trailing underscore is not the supplied account.

**Why:** The saved candidate set included several profiles selected on partial-name overlap, while its `belloo_official` snippet described a different singer/songwriter. All saved results were explicitly unverified.

**How to apply:** Use this as a negative identity-resolution test. Never import `belloo_official` for Frankelly Bello; route the supplied exact URL through the link-claim resolver and keep it unapproved unless resolution supports it.

The user reports that Gula Mın 76 has no Instagram account; the saved `gulagulafestival` result is a festival page, not her account.

**Why:** Serper returned a partial-name hit describing a festival in Vilvoorde, and the saved result had zero high-confidence candidates.

**How to apply:** Never associate `gulagulafestival` with Gula Mın 76. Treat this as a negative identity-resolution case; do not convert a same-name festival hit into an artist link.

A failed artist-name search does not establish that an Instagram account is unindexed.

**Why:** Exact Instagram-path searches recovered a known account that multiple name-only searches missed; its indexed display name differed from its artist name.

**How to apply:** Discover handle clues from identity-linked reference sources, then use exact-path Serper checks. Clearly distinguish recovery using a supplied handle from independent name-based discovery; do not guess handles and call them confirmed.

Treat an empty current-day tier selection immediately after UTC midnight as a possible snapshot-refresh gap, not proof that the tier has no artists.

**Why:** The database day advanced before the next tier computation arrived; the latest completed musician snapshot still contained the expected population.

**How to apply:** Inspect snapshot timestamps before reporting an empty cohort. For an explicitly requested run, disclose and pin a recent completed snapshot, rejecting one older than 36 hours rather than silently selecting stale historical assignments. Keep ordinary current-day selection unchanged unless this alternative is explicitly chosen.

Reconcile a final saved-status snapshot before treating a completed worker's profile as unfinished.

**Why:** Multiple completed research batches initially reported one profile as still running even though all worker completions were logged; a fresh read then showed the final saved result without another provider call. The visibility delay's exact cause has not been established.

**How to apply:** Refresh the read-only status/report once after workers finish. Never repeat a paid search solely because the immediate aggregate still says running; investigate persistence if the discrepancy remains.

A configured identity verifier does not establish that a separate research pipeline actually used it.

**Why:** The historical musician research saved Serper candidates without metadata comparisons or JEV decisions, even though the interactive application supported those checks. Discovery coverage therefore overstated evidence of correct artist ownership. Pilot preflight also found missing or unrecognized reference accounts, so abstention can reflect input gaps rather than an incorrect Instagram identity.

**How to apply:** Inspect persisted per-candidate identity evidence and catalog-reference binding for each execution path before calling its URLs verified or import-ready. Before paid checks, measure reference readiness and verify that external bio-link targets reach the identity evidence. Report missing evidence separately from proven wrong accounts; name-overlap and shared-handle flags are not measured false-positive rates.

Strict abstention must be evaluated alongside independent recovery of known correct accounts; rejecting every candidate does not make a rerun ready.

**Why:** A live regression pilot independently recovered a user-confirmed account but initially could not traverse its music landing page. Another known account was missed when searches returned posts and topic pages instead of a direct profile URL. Even after the exact music-ID path was collected, the model still abstained. None of those failures alone proves a wrong identity or account absence.

**How to apply:** Keep known-answer handles separate from discovery inputs, test both false-positive prevention and known-positive recovery before expanding, and distinguish missing discovery/link-path evidence from an actual mismatch. When a visible music-service button has not been followed, describe an unchecked verification path, not a missing link or a questionable Instagram account. Report a model disagreement separately from the objective cross-link evidence; a low model score does not erase an observed music-ID match. Do not weaken identity thresholds merely to increase acceptance.

Verification inputs must distinguish unassessed ownership from negative ownership evidence and retain the source-to-target music link chain.

**Why:** The pilot sent a hardcoded negative ownership flag for an unassessed account, dropped the links connecting its music landing page to Spotify recordings, and combined insufficient evidence with a different identity in one classifier criterion. A model abstention on that input cannot isolate which defect mattered. A same-model paired check of the repaired input improved a known-positive decision while retaining negative-control rejections, but the verified label still did not satisfy the separate numeric gate.

**How to apply:** Keep technical music-ID matches separate from artist-account ownership, represent unknown as unknown, and retain both intermediate destinations and bound final artist IDs. Validate the repaired evidence contract offline first; only a controlled live comparison can establish whether model decisions improve. Report the verifier's categorical verdict separately from its numeric score and application acceptance; do not calibrate thresholds or claim population accuracy from one known-positive case.

More explicit verifier instructions can reduce known-positive scores even when exact-link evidence is made clearer.

**Why:** A capped saved-evidence check returned lower scores than two earlier positive JEV decisions while both unrelated controls remained mismatches. This does not isolate wording from model variability. A later generic ownership-criteria experiment changed a known-positive verdict to verified without meeting the independent numeric gate, while making a known wrong account's verdict/score less conservative. Better positive labels alone are not evidence of a safer acceptance policy. The unchanged 0.90 gate prevented promotion.

**How to apply:** Treat prompt and evidence-schema changes as behavior changes; compare known positives and negatives before scaling. Keep experimental criteria opt-in when results are mixed, report verdict and numeric acceptance separately, and watch negative-score movement even when no wrong account crosses the threshold. Do not weaken the acceptance threshold to compensate. Preserve uncertainty and the original results when an experiment regresses.

Existing catalog Instagram links are provisional benchmark labels, not independently adjudicated ground truth.

**Why:** The broader verification diagnostic uses catalog-linked accounts as positive controls and rotated accounts from other catalog artists as negative controls. Catalog errors, aliases and related entities can undermine those assumptions; such a sample cannot establish population precision or recall. A separate user-confirmed regression check also held known positives while declining the known wrong account. That demonstrates missed positives under the supplied labels and saved evidence, but does not isolate an overly strict numeric threshold from missing evidence or verifier instructions.

**How to apply:** Retain label provenance, keep benchmark labels outside verifier inputs, and report verifier-only checks separately from full discovery acceptance. Report artist/account pairs, distinct artists, distinct account handles and repeated policy evaluations separately; reused controls are not independent samples. User-confirmed corrections can anchor a regression test but do not constitute newly rechecked live ownership or catalog evidence. Never invent a missing music cross-link to make an expected-positive example pass; distinguish a verifier hold from an independent evidence-gate hold. Investigate control disagreements rather than automatically correcting the catalog or treating every abstention as a known false negative.

Direct Instagram bio links must remain distinct from music URLs derived through landing pages.

**Why:** A saved-evidence audit found a derived Spotify artist URL had been labeled a direct Instagram bio link. A subsequent comparison also paired unrelated controls with their own references, making its before/after scores misleading.

**How to apply:** Restore direct-link provenance from raw provider packets for historical evidence; unknown provenance must not be described as direct. Bind every control to the same target catalog identity as its positive, calculate comparison status from the evidence, and preserve identical request hashes for repeatability checks. Stable repeated scores do not prove ownership or justify relaxing acceptance rules.

Keep prior workflow judgments distinct from observed source facts when testing identity verifiers.

**Why:** An alternate verifier recognized exact music links but cited the application's own "ownership unassessed" label as a reason it could not verify ownership. Removing only internal comparison/music-path judgments made both provisional positives pass its diagnostic threshold on repeated inputs while neither unrelated control passed. A broader saved-evidence check also supported the user-confirmed Frankelly account, but gave confident verified verdicts to other candidates lacking required exact catalog links; the separate evidence gate correctly held those. A subsequent controlled comparison using JEV did not reproduce that improvement: the source-facts-only variants still abstained, with lower identity scores. A prompt diagnosis for one verifier does not establish the same cause or remedy for another.

**How to apply:** Test source facts separately from internal comparison/ownership labels under a controlled, approved scope. Never replace unknown with confirmed ownership. Preserve the independent catalog-bound evidence gate even when a model says verified with high confidence. Model explanations are diagnostic clues, not established causal explanations for another model, and self-reported scores from different verifiers are not calibrated equivalents. Use independently confirmed artist-owned accounts and related-entity negatives to assess whether abstention is excessive; provisional positives plus unrelated-artist controls cannot calibrate the acceptance threshold.

A music landing page's global navigation and promoted profiles are not artist-declared links.

**Why:** A live Linktree check exposed unrelated creator profiles and site navigation as whole-page anchors. Following all allowlisted links would create false identity paths even though each host was safe to fetch.

**How to apply:** Require profile-bound declared link records for Linktree traversal; domain safety is not ownership provenance. Keep generic related-artist references separate from exact credits, and do not infer ownership of a multi-track album from its title or one selected track. An unavailable path or missing credit ID remains unresolved, not evidence of account absence.

Readable webpage extraction can omit valid artist-owned social icon links.

**Why:** First-party artist websites' readable extracts omitted social links, while their HTML contained both the exact Instagram URL and the expected Spotify artist ID. Treating the text-only extract as complete would have discarded useful reference evidence.

**How to apply:** Inspect bounded source HTML anchors before concluding that an artist website has no social link. Bind first-party website ownership and both account IDs explicitly, preserve timestamps/source hashes, and distinguish artist-site footer links from a link aggregator's unrelated global navigation. Keep independently collected grading evidence distinct from evidence actually supplied to a verifier; a hold on incomplete input does not isolate model calibration.

Check existing exact catalog album-to-artist relationships before adding another credit provider or inferring album ownership from public embeds.

**Why:** Public Spotify album embeds omitted usable artist IDs even though the existing music catalog already contained exact album-to-artist mappings matching the saved artist references. More public-page scraping was unnecessary for those music connections. Supplying those exact relationships to the production verifier still resulted in ownership abstentions, so completing the music path alone does not establish verifier readiness.

**How to apply:** Inspect the current schema and bind lookup inputs to actual source-linked album IDs. Query all current artist relationships before comparing the expected ID, rather than filtering other artists away. Preserve catalog provenance and timestamps separately from public-page evidence; never invent an unknown observation timestamp or substitute replay time. Exclude deleted, conflicting, multi-artist and compilation evidence from automatic acceptance. Bound and journal catalog reads separately without increasing public/paid allowances. A matching music relationship supports identity verification but does not independently prove Instagram ownership or authorize ingestion.
