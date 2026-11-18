---
name: Saved candidate provenance
description: Distinguish the larger saved search pool from richer local recheck captures.
---

Local recheck archives are not the complete saved musician-candidate pool.
Other saved discovery records may contain search URLs, titles and snippets
without captured account biographies or identity metadata.

**Why:** A next-batch request initially looked limited by the local archives,
but ClickHouse contained a much larger search-only pool. Reusing those records
is not an evidence-equivalent continuation of a profile-metadata-rich batch.

**How to apply:** Check both sources before claiming saved artists are exhausted.
Exclude the prior artist cohort before selecting another batch. Label search
snippets separately from captured account facts; never copy a search title or
snippet into an account display name or biography. If missing account details
would require provider calls, disclose the evidence difference and obtain
approval rather than silently expanding a saved-only run.

Do not join a musician cohort to a similarly named catalog table by numeric
profile ID alone. Confirm the profile/Chartmetric artist identity pair first.

**Why:** Parallel catalog schemas can return plausible account rows for
overlapping numeric IDs even when their profile records belong to a different
identity model. A nonempty account query is not validation of that join.

**How to apply:** Reuse the musician metadata query builder's source model,
freeze the returned profile and account bindings, and reject identity mismatches
before any provider admission. Do not silently substitute another catalog model.

Inspecting saved alternatives requires a fresh explicit scope approval; never
retrofit the option into an existing frozen or running scope. Give all artists a
first-candidate turn before spending on second candidates. Metadata may be reused
for an exact account, but an ownership assessment belongs to the artist/account
pair and cannot be shared across artists.

**Why:** The original enriched saved batch approved one candidate per artist.
Alternatives change the paid allocation, and a shared handle does not establish
which catalog artist owns the account.

**How to apply:** Keep the total approved parent ceiling authoritative across all
rounds and providers; preserve shared-handle conflicts and never automatically
replay uncertain admissions.

Legacy account exports without source-query provenance must be re-exported, not
grandfathered in or relabeled as musician records.

**Why:** Validating numeric IDs after the fact cannot recover which parallel
catalog supplied an account. A new provenance label cannot repair an unknown join.

**How to apply:** Fail preparation closed when source provenance is absent. Keep
the original evidence untouched and create a fresh read-only musician export;
this still does not verify ownership or authorize paid provider work.

Keep secondary catalog accounts available as contextual evidence even when a
primary Spotify reference is selected. Exact public-handle reuse across platforms
is supporting context, not an observed owner-declared link or automatic acceptance.

**Why:** A user-confirmed missed match had a catalog TikTok handle identical to
the Instagram candidate, but selecting Spotify as the sole reference withheld
that corroboration. This was an input omission, not a score-threshold failure.

**How to apply:** Preserve artist/account identity binding, inactive-account and
shared-handle safeguards. Audit saved input completeness without relabeling old
model answers or claiming the omitted evidence would necessarily change them.
New paid checks need their own approval; never rewrite frozen scopes.

Treat imported interrupted and final saved-alternative observations as immutable
snapshots, not updates to the same published document.

**Why:** A final summary can arrive after an interrupted checkpoint has already
been reviewed. Replacing that archive would change the evidence behind the
earlier review, while refusing every later snapshot would hide the final result.

**How to apply:** Preserve earlier observations when importing later checkpoints.
Identify the scope and observation separately, and label spending from an
interrupted checkpoint as an observation that can precede newer admissions,
not as a reconciled invoice or permission to resume.

A recent-title catalog export is positive matching evidence, not a complete
discography or proof that an artist has no primary-credit releases.

**Why:** A title-limited export can omit older corroborating recordings or primary
credits. Treating an omitted row or artist as an empty catalog creates false rejections.

**How to apply:** Preserve the export's stated coverage. Report absent fields and
omissions separately; require affirmative credit/channel evidence for a Wrong verdict.
