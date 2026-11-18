"""Proof-first assessment: observed conflicts > qualifying proof > missing work.

No oracle, network, database, model or account-name comparisons.
"""
from urllib.parse import urlsplit

from instagram_proof_trial import identity, instagram_url

RULES = "instagram-explicit-proof-first-v4"


def assess(artist, anchors, candidates, progress):
    incomplete, manual, proofs, rejected = [], [], [], []
    roots = {a["anchor_id"]: a for a in artist["anchors"]
             if a.get("catalog_owned") and not a["anchor_id"].startswith(
                 ("followup:", "candidate-hub:"))}
    trusted, remaining = [], list(anchors)
    checked_ids = {a["anchor_id"] for a in anchors}
    if not artist.get("anchor_inventory_complete"):
        incomplete.append("CATALOG_INVENTORY_GAPS")
    if not set(roots) <= checked_ids:
        incomplete.append("MISSING_ANCHOR_CHECK")
    if not progress.get("searches_complete"):
        incomplete.append("SEARCH_INCOMPLETE")
    # Follow-up ownership comes from a recorded declaration on an already
    # trusted source, never from a candidate's arbitrary link hub.
    for _ in range(len(remaining) + 1):
        ready = {r["receipt_id"]: r for r in trusted}
        moved = []
        for row in remaining:
            root = roots.get(row["anchor_id"])
            parent = ready.get(row.get("parent_receipt_id"))
            bound = root and identity(root["url"]) == identity(row["url"])
            if parent:
                declared = parent.get("website_declarations", []) + parent.get("hub_links", [])
                bound = bound or identity(row["url"]) in {identity(u) for u in declared}
            if bound:
                moved.append(row)
                if row.get("status") == "ok" and row.get("identity_bound") and row.get("receipt_id"):
                    trusted.append(row)
                else:
                    incomplete.append("ANCHOR_UNAVAILABLE_OR_UNBOUND")
        if not moved:
            break
        remaining = [r for r in remaining if r not in moved]
    if remaining:
        incomplete.append("ANCHOR_UNAVAILABLE_OR_UNBOUND")

    # Catalog seeds are known pages. Captured canonical channel IDs are
    # aliases only after the provider response was identity-bound to that seed.
    references = {}
    for row in roots.values():
        ident = identity(row["url"])
        if ident:
            references[ident] = {"catalog_url": row["url"], "anchor_id": row["anchor_id"]}
    for row in trusted:
        for value in (row["url"], row.get("returned_url")):
            ident = identity(value)
            if ident and ident[0] in ("spotify", "youtube"):
                references[ident] = {
                    "catalog_url": row["url"], "receipt_id": row["receipt_id"],
                    "capture_sha256": row["capture_sha256"],
                    "basis": "IDENTITY_BOUND_ACCOUNT_ALIAS",
                }
        for value in row.get("website_declarations", []):
            if ident := identity(value):
                references[ident] = {
                    "catalog_url": value, "declared_by": row["url"],
                    "receipt_id": row["receipt_id"],
                    "capture_sha256": row["capture_sha256"],
                    "basis": "ARTIST_PROFILE_DECLARED_WEBSITE_OR_HUB",
                }
        for value in row.get("links", []):
            if target := instagram_url(value):
                proofs.append({
                    "kind": "artist_page_links_to_instagram", "instagram_url": target,
                    "source_url": row["url"], "receipt_id": row["receipt_id"],
                    "capture_sha256": row["capture_sha256"], "observed_at": row["observed_at"],
                    "parent_receipt_id": row.get("parent_receipt_id"),
                    "context_fields": row["context_fields"],
                })
        if row.get("negative_complete") is not True:
            incomplete.append("ANCHOR_NEGATIVE_LINK_INVENTORY_INCOMPLETE")
    anchor_targets = {p["instagram_url"] for p in proofs}
    handles = {i[2].casefold() for i in references if i[0] in ("twitter", "tiktok")}
    known_spotify = {i for i in references if i[0] == "spotify"}
    for candidate in candidates:
        url = candidate["url"]
        if candidate.get("status") != "ok" or not candidate.get("identity_bound"):
            incomplete.append("CANDIDATE_CAPTURE_INCOMPLETE")
            rejected.append({"url": url, "reason": candidate.get("reason", "CAPTURE_INCOMPLETE")})
            continue
        observed = {identity(v) for v in candidate.get("links", [])}
        matches = sorted(set(references) & observed)
        handle = urlsplit(url).path.strip("/").casefold()
        positive = bool(matches) or handle in handles or url in anchor_targets
        other_spotify = {i for i in observed if i and i[0] == "spotify"} - known_spotify
        if known_spotify and other_spotify and positive:
            manual.append("CANDIDATE_POINTS_TO_DIFFERENT_SPOTIFY_ARTIST")
            rejected.append({"url": url, "reason": "CONFLICTING_SPOTIFY_ID",
                             "receipt_id": candidate["receipt_id"]})
        elif matches or handle in handles:
            proofs.append({
                "kind": "instagram_catalog_backlink" if matches else "exact_catalog_twitter_tiktok_handle",
                "instagram_url": url, "source_url": url,
                "receipt_id": candidate["receipt_id"],
                "capture_sha256": candidate["capture_sha256"],
                "observed_at": candidate["observed_at"],
                "matched_catalog_identities": matches,
                "reference_provenance": [references[m] for m in matches],
                "matched_handle": handle if handle in handles else None,
                "hub_receipt_ids": candidate.get("hub_receipt_ids", []),
            })
        else:
            rejected.append({"url": url, "reason": "NO_EXACT_OWNERSHIP_PROOF",
                             "receipt_id": candidate["receipt_id"]})
        if candidate.get("followups_complete") is not True:
            incomplete.append("CANDIDATE_HUB_CHECK_INCOMPLETE")
        if candidate.get("negative_complete") is not True:
            incomplete.append("CANDIDATE_LINK_INVENTORY_INCOMPLETE")
    if not progress.get("anchor_followups_complete"):
        incomplete.append("ANCHOR_FOLLOWUPS_INCOMPLETE")
    if not progress.get("all_candidates_captured"):
        incomplete.append("CANDIDATE_CAPTURE_LIMIT_OR_MISSING_WORK")
    targets = {p["instagram_url"] for p in proofs}
    if len(targets) > 1:
        manual.append("CONFLICTING_PROVEN_INSTAGRAMS")
    if manual:
        state = "MANUAL_REVIEW"
    elif len(targets) == 1:
        state = "VERIFIED"
    elif incomplete:
        state = "UNFINISHED"
    else:
        state = "NOT_FOUND"
    return {
        "state": state,
        "instagram_url": next(iter(targets)) if state == "VERIFIED" else None,
        "rules_version": RULES, "proof": proofs, "candidates_checked": candidates,
        "rejected_candidates": rejected,
        "reason_codes": sorted(set(manual)) if manual else (
            ["EXPLICIT_OWNERSHIP_PROOF"] if state == "VERIFIED" else
            sorted(set(incomplete)) or ["COMPLETED_PROTOCOL_NO_PROOF"]),
        "unfinished_checks": sorted(set(incomplete)),
        "unfinished_checks_blocking": bool(incomplete) and state == "UNFINISHED",
    }
