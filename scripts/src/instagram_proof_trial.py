"""Offline ownership-proof decisions. No provider, model, environment or DB access.

Receipts are normalized source-field extractions, not arbitrary page hyperlinks.
A future collector must bind each returned identity, validate the source field,
retain the raw sanitized capture, and check its hash before creating a receipt.
These rules intentionally cannot turn missing/failed collection into NOT_FOUND.
"""

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

RULES_VERSION = "instagram-owned-anchor-trial-v1"
REVIEW_SEED = 2026111701
CONTROL_SEED = 2026111702
MAX_SPEND_CENTS = 12000
MAX_PAID_REQUESTS = 6000
MAX_EVIDENCE_AGE_DAYS = 30
INSTAGRAM_RESERVED = {
    "p", "reel", "reels", "stories", "explore", "accounts", "direct", "about",
    "developer", "legal", "privacy", "terms", "share", "challenge", "web",
}
HUB_HOSTS = {"linktr.ee", "beacons.ai", "bio.site", "lnk.bio", "solo.to", "hoo.be"}


def digest(value):
    return hashlib.sha256(json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        allow_nan=False).encode()).hexdigest()


def safe_url(value):
    """Canonical identity URL only. Transport must independently fence DNS."""
    try:
        u = urlsplit(str(value))
        host = (u.hostname or "").lower().removeprefix("www.")
        if u.scheme not in ("https", "http") or u.username or u.password or u.port:
            return None
        if not host or "." not in host or host.endswith("."):
            return None
        if host in ("localhost", "metadata.google.internal") or re.fullmatch(r"[\d.]+", host):
            return None
        if ":" in host:
            return None
        query = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True)
                 if not k.lower().startswith("utm_") and k.lower() not in ("fbclid", "igshid")]
        return urlunsplit(("https", host, u.path.rstrip("/") or "", urlencode(query), ""))
    except ValueError:
        return None


def instagram_url(value):
    value = safe_url(value)
    if not value:
        return None
    u = urlsplit(value)
    if u.hostname not in ("instagram.com", "m.instagram.com"):
        return None
    path = u.path.strip("/")
    if "/" in path or path.lower() in INSTAGRAM_RESERVED:
        return None
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.]{0,29}", path, re.ASCII):
        return None
    return "https://www.instagram.com/" + path.lower() + "/"


def identity(value):
    if isinstance(value, str) and re.fullmatch(r"spotify:artist:[A-Za-z0-9]{22}", value):
        return ("spotify", "artist", value.split(":")[-1])
    value = safe_url(value)
    if not value:
        return None
    u = urlsplit(value)
    parts = [unquote(p) for p in u.path.split("/") if p]
    host = u.hostname
    if host == "open.spotify.com":
        if parts and parts[0].startswith("intl-"):
            parts = parts[1:]
        if len(parts) == 2 and parts[0] == "artist" and re.fullmatch(r"[A-Za-z0-9]{22}", parts[1]):
            return ("spotify", "artist", parts[1])
        return None
    if host in ("youtube.com", "music.youtube.com", "m.youtube.com"):
        if len(parts) == 2 and parts[0] == "channel" and re.fullmatch(r"UC[A-Za-z0-9_-]{22}", parts[1]):
            return ("youtube", "channel", parts[1])
        if len(parts) == 1 and re.fullmatch(r"@[^/?#]+", parts[0]):
            return ("youtube", "handle", parts[0][1:].casefold())
        return None
    if host in ("twitter.com", "x.com"):
        if len(parts) == 1 and re.fullmatch(r"[A-Za-z0-9_]{1,15}", parts[0]):
            if parts[0].lower() not in ("home", "share", "intent", "search", "explore", "i"):
                return ("twitter", "handle", parts[0].lower())
        return None
    if host in ("tiktok.com", "m.tiktok.com"):
        if len(parts) == 1 and parts[0].startswith("@") and len(parts[0]) > 1:
            return ("tiktok", "handle", parts[0][1:].casefold())
        return None
    # Other website identities are compared exactly, not by a shared host.
    return ("website", "url", value)


def receipt_ok(record, profile, now):
    """Fail closed on missing identity, time, extraction completeness or bytes."""
    if record.get("profile_id") != profile["profile_id"] or record.get("cm_artist") != profile["cm_artist"]:
        return False
    if record.get("status") != "ok" or record.get("links_complete") is not True:
        return False
    if not all(isinstance(record.get(k), str) and record[k] for k in (
            "evidence_id", "source_url", "returned_account_url")):
        return False
    if not re.fullmatch(r"[0-9a-f]{64}", record.get("raw_capture_sha256", "")):
        return False
    if record.get("extraction_kind") not in (
            "artist_profile_owned_links", "artist_website_links", "owned_link_hub_links",
            "instagram_direct_bio_links"):
        return False
    links = record.get("links")
    if not isinstance(links, list) or not all(isinstance(link, str) for link in links):
        return False
    try:
        at = datetime.fromisoformat(record["observed_at"].replace("Z", "+00:00"))
        return (at.tzinfo is not None and now.tzinfo is not None
                and now - timedelta(days=MAX_EVIDENCE_AGE_DAYS) <= at <= now + timedelta(minutes=5))
    except (KeyError, TypeError, ValueError):
        return False


def result(state, reasons, proof=None, rejected=None):
    return {"state": state, "reason_codes": sorted(set(reasons)),
            "proof_edges": proof or [], "rejected_candidates": rejected or [],
            "rules_version": RULES_VERSION}


def decide(profile, anchor_receipts, candidates, progress, *, now):
    """VERIFIED/NOT_FOUND are terminal. UNFINISHED is a separate work queue.

Only inputs with explicit catalog-owned anchors are valid. Scores, names,
search snippets, Instagram badges and the hidden control truth are ignored.
Aliases must come from separately identity-bound catalog captures, never a
name-based assumption. Recursion/follow-up pages are not silently inferred.
"""
    anchors = profile.get("anchors", [])
    by_id = {a["anchor_id"]: a for a in anchors}
    if len(by_id) != len(anchors) or not profile.get("anchor_inventory_complete"):
        return result("UNFINISHED", ["ANCHOR_INVENTORY_INCOMPLETE"])
    if any(not a.get("catalog_owned") or not identity(a.get("url"))
           or instagram_url(a.get("url")) for a in anchors):
        return result("UNFINISHED", ["UNBOUND_OR_UNSUPPORTED_CATALOG_ANCHOR"])
    receipts, proof, targets, problems = {}, [], set(), []
    for receipt in anchor_receipts:
        anchor_id = receipt.get("anchor_id")
        if anchor_id not in by_id or anchor_id in receipts:
            return result("UNFINISHED", ["UNBOUND_OR_DUPLICATE_ANCHOR_RECEIPT"])
        receipts[anchor_id] = receipt
        anchor = by_id[anchor_id]
        expected = identity(anchor["url"])
        if (not receipt_ok(receipt, profile, now)
                or identity(receipt.get("source_url")) != expected
                or identity(receipt.get("returned_account_url")) != expected
                or receipt.get("extraction_kind") == "instagram_direct_bio_links"):
            problems.append("ANCHOR_CHECK_INCOMPLETE")
            continue
        for raw in receipt["links"]:
            url = instagram_url(raw)
            if url:
                targets.add(url)
                proof.append({"kind": "artist_page_links_to_instagram",
                              "anchor_id": anchor_id, "source_url": receipt["source_url"],
                              "target_url": url, "evidence_id": receipt["evidence_id"],
                              "observed_at": receipt["observed_at"],
                              "raw_capture_sha256": receipt["raw_capture_sha256"]})
    if len(targets) > 1:
        return result("UNFINISHED", ["CONFLICTING_ANCHOR_INSTAGRAMS_MANUAL_REVIEW"], proof)
    if set(receipts) != set(by_id) or problems or progress.get("anchor_followups_complete") is not True:
        return result("UNFINISHED", problems + ["ANCHOR_LOOKUP_NOT_COMPLETED"], proof)
    if targets:
        return result("VERIFIED", ["OWNED_PAGE_OUTBOUND_LINK"], proof)
    # Search is permitted only now: successful anchor lookup found nothing.
    if progress.get("searches_complete") is not True:
        return result("UNFINISHED", ["SEARCH_PROTOCOL_INCOMPLETE"])
    required_queries = progress.get("required_query_count")
    if required_queries != 2 or progress.get("successful_query_count") != required_queries:
        return result("UNFINISHED", ["SEARCH_RECEIPTS_INCOMPLETE"])
    expected_ids = {identity(a["url"]) for a in anchors}
    allowed_ids = {i for i in expected_ids if i and (
        i[0] == "spotify" or i[0] == "youtube" or
        (i[0] == "website" and urlsplit(i[2]).hostname not in HUB_HOSTS))}
    social_handles = {i[2] for i in expected_ids if i and i[0] in ("twitter", "tiktok") and i[1] == "handle"}
    seen, qualifying, rejected, incomplete = set(), [], [], False
    for capture in candidates:
        url = instagram_url(capture.get("source_url"))
        if not url or url in seen:
            return result("UNFINISHED", ["UNBOUND_OR_DUPLICATE_CANDIDATE"])
        seen.add(url)
        if (not receipt_ok(capture, profile, now)
                or instagram_url(capture.get("returned_account_url")) != url
                or capture.get("extraction_kind") != "instagram_direct_bio_links"):
            incomplete = True
            rejected.append({"url": url, "reason": "CAPTURE_INCOMPLETE_NOT_AN_IDENTITY_REJECTION"})
            continue
        # Unresolved candidate hubs must be collected by a separately bound
        # adapter before this rule can conclude the candidate was assessed.
        if any(safe_url(link) and urlsplit(safe_url(link)).hostname in HUB_HOSTS
               for link in capture["links"]):
            incomplete = True
            rejected.append({"url": url, "reason": "CANDIDATE_LINK_HUB_NOT_YET_RESOLVED"})
            continue
        observed = {identity(link) for link in capture["links"]}
        known_spotify = {i for i in expected_ids if i and i[0] == "spotify"}
        other_spotify = {i for i in observed if i and i[0] == "spotify"} - known_spotify
        if known_spotify and other_spotify:
            incomplete = True
            rejected.append({"url": url, "reason": "CONFLICTING_SPOTIFY_ARTIST_MANUAL_REVIEW"})
            continue
        matched = sorted(allowed_ids & observed)
        handle = urlsplit(url).path.strip("/")
        if matched or handle in social_handles:
            qualifying.append(url)
            proof.append({"kind": "candidate_catalog_backlink" if matched else "exact_catalog_twitter_tiktok_handle",
                          "source_url": url, "matched_catalog_identities": matched,
                          "matched_handle": handle if handle in social_handles else None,
                          "evidence_id": capture["evidence_id"], "observed_at": capture["observed_at"],
                          "raw_capture_sha256": capture["raw_capture_sha256"]})
        else:
            rejected.append({"url": url, "reason": "NO_EXACT_CATALOG_BACKLINK_OR_ALLOWED_SOCIAL_HANDLE"})
    if len(qualifying) > 1:
        return result("UNFINISHED", ["MULTIPLE_QUALIFYING_CANDIDATES_MANUAL_REVIEW"], proof, rejected)
    if (incomplete or progress.get("all_discovered_candidates_disposed") is not True
            or progress.get("candidate_hub_followups_complete") is not True):
        return result("UNFINISHED", ["CANDIDATE_PROTOCOL_INCOMPLETE"], proof, rejected)
    if qualifying:
        return result("VERIFIED", ["CAPTURED_CATALOG_BACKLINK_OR_EXACT_SOCIAL_HANDLE"], proof, rejected)
    return result("NOT_FOUND", ["COMPLETED_PROTOCOL_NO_QUALIFYING_ACCOUNT"], rejected=rejected)


def evaluate(frozen_results, hidden_controls):
    """Evaluator only. Never feed known URLs to sourcing or the decision rules."""
    if len({r["profile_id"] for r in frozen_results}) != len(frozen_results):
        raise ValueError("Duplicate final profile decision")
    if len(hidden_controls) != 200 or len({r["profile_id"] for r in hidden_controls}) != 200:
        raise ValueError("Exactly 200 distinct controls required")
    by_id = {r["profile_id"]: r for r in frozen_results}
    if not set(r["profile_id"] for r in hidden_controls) <= set(by_id):
        raise ValueError("Missing control outcomes; never silently change denominators")
    counts = {"VERIFIED": 0, "NOT_FOUND": 0, "UNFINISHED": 0, "known_url_match": 0}
    for control in hidden_controls:
        r = by_id[control["profile_id"]]
        truth = {instagram_url(u) for u in control["accepted_urls"]}
        if None in truth or not truth:
            raise ValueError("Invalid withheld control truth")
        if control.get("cm_artist") is not None and control["cm_artist"] != r.get("cm_artist"):
            raise ValueError("Control identity binding changed")
        if r["state"] not in counts or r["state"] == "known_url_match":
            raise ValueError("Invalid control state")
        counts[r["state"]] += 1
        if r["state"] == "VERIFIED":
            found = {instagram_url(p.get("target_url") or p.get("source_url")) for p in r["proof_edges"]}
            if not found or None in found or len(found) != 1:
                raise ValueError("Verified control must have proof for exactly one Instagram")
            counts["known_url_match"] += bool(found & truth)
    return {
        **counts, "denominator": 200, "found_rate": counts["VERIFIED"] / 200,
        "known_link_agreement": (counts["known_url_match"] / counts["VERIFIED"]
                                 if counts["VERIFIED"] else None),
        "false_not_found_rate": counts["NOT_FOUND"] / 200,
        "unfinished_rate": counts["UNFINISHED"] / 200,
    }
