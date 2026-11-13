---
name: Batch results review
description: User requirements for reviewing batch findings and metadata in the artists page.
---

Batch results must expose everything included in the findings CSV, using progressive disclosure rather than removing detail to simplify the interface.

**Why:** The user asked for an on-page component for each batch because the CSV contains too much information to show at once. Earlier feedback specifically required visible artist names and Instagram URLs, including candidates that were not accepted.

**How to apply:** Keep the artist and candidate/accepted-link distinction easy to find. Make the full metadata and original evidence accessible on demand. Preserve the distinction between metadata actually supplied to the checker and metadata merely available; incomplete capture or an unaccepted candidate must not be presented as proof of an absent account.

In comparison exports, ordinary result columns must describe the latest check.
Label earlier decisions and inputs explicitly as previous values.

**Why:** Leaving old false flags and old scores in the main columns made a
successful recheck appear to have no likely matches when the user opened the CSV.

**How to apply:** Keep the main status, likely-match flag, score, verdict, reason,
model and metadata-used fields aligned to the same observation. Preserve the
historical records and expose their values separately; never silently update
live-link ownership when correcting an export.

Instagram CSVs must have one Instagram account URL per row, not joined URL lists.

**Why:** The user explicitly requested one Instagram URL per row after receiving
artist-level exports.

**How to apply:** Repeat artist names and IDs as needed, but bind each row's score,
verdict, and reason to that URL's own saved check. When splitting by candidate
outcome, explain that an artist can appear in both files and that URL-row counts
are not distinct-artist counts.

Treat saved-run grouping as display-only identity, not a spending ledger or permission to resume.

**Why:** Checkpoints repeat cumulative parent spending, and a final saved summary can describe a stopped run. Adding snapshots together or equating finality with successful completion would misrepresent the evidence.

**How to apply:** Keep older archives immutable, preserve each observation's amounts and ordering, and use legacy identity inference only when structured metadata is absent—not to override malformed explicit metadata.

YouTube deliverable CSVs must have one row per artist/channel pair, not one row
per source video. Keep different channels for the same artist as separate rows.

**Why:** The user stated, "we're collecting URLs ... for the channel, not any
specific videos," after duplicate video rows repeated the same artist/channel.

**How to apply:** Deduplicate within the exact profile/Chartmetric identity and
canonical channel URL. Keep supporting videos together as secondary evidence,
retain Topic labels and unresolved status, and never merge different artists
just because they share a channel. Preserve historical raw receipts unchanged.

For YouTube reviews, present possible artist channels separately from excluded
uploaders. A full uploader evidence list must not be presented as found artist
links, even when it includes names and track credits.

**Why:** During review, the user repeatedly identified label, lyrics, group,
collaborator and song-title matches in the full evidence export as false
artist-channel matches. A music association is not channel identity.

**How to apply:** Lead with the candidate-only export, explicitly unverified;
keep held and rejected pairs separately accessible with reasons. Require all
observations in an artist/channel group to clear triage before shortlisting it.
Conflicting uploader names or held evidence must not be hidden by one positive
observation. Keep Topic labels and user reviews distinct from automated checks.
