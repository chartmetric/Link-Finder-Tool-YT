"""Single-artist ownership gate over proof-first v4. Pure: no fetching or oracle."""
import copy
from urllib.parse import urlsplit

from instagram_proof_trial import identity, instagram_url
from instagram_trial_v4_rules import assess as proof_first
from instagram_trial_v4_sources import is_hub

RULES = "instagram-single-artist-proof-v5"


def assess(artist, anchors, candidates, progress, excluded_identities=(), publisher_hosts=()):
    artist, gated_anchors = copy.deepcopy(artist), copy.deepcopy(anchors)
    progress = copy.deepcopy(progress)
    blocked = set(excluded_identities)
    exclusions = []

    def denied(row):
        keys = {identity(row.get("url")), identity(row.get("returned_url"))} - {None}
        return (bool(keys & blocked) or row.get("ownership_scope", {}).get("status") == "excluded_multi_artist"
                or (not is_hub(row["url"]) and urlsplit(row["url"]).hostname in publisher_hosts))

    for row in anchors + candidates + [h for c in candidates for h in c.get("hub_checks", [])]:
        if denied(row):
            blocked.update(i for u in (row["url"], row.get("returned_url")) if (i := identity(u)))

    def usable(row):
        return not denied(row) and row.get("ownership_scope", {}).get("status") == "artist_specific"

    pages = anchors + [h for c in candidates for h in c.get("hub_checks", [])]
    allowed = {i for a in pages if usable(a)
               for u in (a["url"], a.get("returned_url")) if (i := identity(u))}
    by_anchor = {a["anchor_id"]: a for a in anchors}
    # Known exact Spotify IDs still support an Instagram backlink even when
    # capture failed, unless actual saved evidence excludes that reference.
    for root in artist["anchors"]:
        ident = identity(root["url"])
        row = by_anchor.get(root["anchor_id"])
        exact_artist = ident and ident[:2] == ("spotify", "artist") and ident not in blocked
        if not exact_artist and (not row or not usable(row)):
            root["catalog_owned"] = False
        elif exact_artist:
            allowed.add(ident)
    blocked_targets = {instagram_url(c["url"]) for c in candidates if denied(c)}
    for row in gated_anchors:
        if not usable(row):
            row["identity_bound"] = False
            exclusions.append({"url": row["url"], "receipt_id": row.get("receipt_id"),
                               "scope": row.get("ownership_scope", {}),
                               "reason": "SOURCE_NOT_CONFIRMED_SINGLE_ARTIST"})
        row["links"] = [u for u in row.get("links", []) if instagram_url(u) not in blocked_targets]
        for field in ("website_declarations", "hub_links"):
            if any(identity(u) not in allowed and identity(u) not in blocked
                   for u in row.get(field, [])):
                progress["anchor_followups_complete"] = False
            row[field] = [u for u in row.get(field, []) if identity(u) in allowed
                          and identity(u) not in blocked]
    gated_candidates = []
    for original in candidates:
        row = copy.deepcopy(original)
        if denied(row):
            row["links"] = []
            exclusions.append({"url": row["url"], "receipt_id": row.get("receipt_id"),
                               "scope": row.get("ownership_scope", {}), "reason": "NON_ARTIST_INSTAGRAM_TARGET"})
        else:
            # Rebuild, do not reuse backlinks flattened through excluded hubs.
            row["links"] = list(row.get("direct_links", []))
            hubs = {identity(h["url"]): h for h in row.get("hub_checks", [])}
            queue, seen = list(row.get("direct_hub_links", [])), set()
            while queue:
                url = queue.pop(0)
                key = identity(url)
                if key in seen:
                    continue
                seen.add(key)
                hub = hubs.get(key)
                if not hub or not usable(hub):
                    if not hub or not denied(hub):
                        row["followups_complete"] = False
                    exclusions.append({"url": url, "receipt_id": hub.get("receipt_id") if hub else None,
                                       "scope": hub.get("ownership_scope", {}) if hub else {},
                                       "reason": "BIO_PAGE_NOT_CONFIRMED_SINGLE_ARTIST"})
                    continue
                row["links"] += hub["links"]
                queue += hub.get("hub_links", [])
        gated_candidates.append(row)
    decision = proof_first(artist, gated_anchors, gated_candidates, progress)
    decision["rules_version"] = RULES
    decision["decision_candidates"] = decision.pop("candidates_checked")
    decision["candidates_checked"] = candidates
    decision["decision_anchor_checks"] = gated_anchors
    decision["ownership_exclusions"] = exclusions
    for rejected in decision["rejected_candidates"]:
        if instagram_url(rejected["url"]) in blocked_targets:
            rejected["reason"] = "EXCLUDED_MULTI_ARTIST_INSTAGRAM"
    return decision
