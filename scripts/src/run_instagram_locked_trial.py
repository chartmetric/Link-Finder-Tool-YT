"""Approved one-shot 100+100 trial. Prepare, then collect without reading oracle.

No retry/resume path. --collect requires a frozen input policy and approval.
An interrupted launch requires offline receipt reconciliation, never replay.
"""
import argparse
import copy
import json
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from instagram_proof_trial import HUB_HOSTS, digest, identity, instagram_url, safe_url
from instagram_trial_extract import provider_request, sc_profile, website_links
from instagram_trial_transport import TrialTransport, file_sha, public_page, save_new, utc
from prepare_instagram_locked_trial import ROOT, RULES

TYPE_PLATFORM = {"1": "twitter", "3": "youtube", "7": "soundcloud",
                 "14": "spotify", "19": "tiktok", "100": "website"}


def finalize_inputs(root):
    scope = json.loads((root / "scope.json").read_text())
    before = json.loads((root / "inputs-before-cm-url.json").read_text())
    packet = json.loads((root / "cm-url-non-instagram.json").read_text())
    for a in before:
        current = {safe_url(x["url"]): x for x in a["anchors"]}
        for row in packet["rows"]:
            if row["cm_artist"] != a["cm_artist"]:
                continue
            url = safe_url(row["url"])
            platform = TYPE_PLATFORM[row["type"]]
            if not url or instagram_url(url) or not identity(url):
                a.setdefault("inventory_gaps", []).append({
                    "reason": "INVALID_CM_URL", "cm_url_id": row["cm_url_id"], "platform": platform})
                continue
            if url not in current:
                current[url] = {
                    "url": url, "platform": platform, "anchor_id": "cm_url:" + row["cm_url_id"],
                    "catalog_owned": True,
                    "trust_basis": "USER_APPROVED_CATALOG_ARTIST_ACCOUNT_SEED_NOT_INDEPENDENTLY_AUDITED",
                    "provenance": row, "catalog_observed_at": packet["observed_at"],
                }
            else:
                current[url].setdefault("additional_catalog_provenance", []).append(row)
        # Deduplicate exact platform identities (tracking query aliases aren't
        # independent accounts), retaining all source records.
        aliases = {}
        for anchor in current.values():
            key = identity(anchor["url"])
            if key in aliases:
                aliases[key].setdefault("catalog_aliases", []).append(anchor)
            else:
                aliases[key] = anchor
        a["anchors"] = list(aliases.values())
        a["anchor_inventory_complete"] = not bool(a.get("inventory_gaps"))
    save_new(root / "inputs.json", before)
    policy = {
        "run_id": scope["run_id"], "rules_version": RULES, "prepared_at": utc(),
        "inputs_sha256": file_sha(root / "inputs.json"), "scope_sha256": digest(scope),
        "catalog_snapshot_sha256": file_sha(root / "cm-url-non-instagram.json"),
        "sample_size_per_group": 100, "searches_per_artist": 2,
        "candidate_capture_bound": scope["max_candidate_captures_per_artist"],
        "anchor_followup_bound": scope["max_anchor_followup_pages_per_artist"],
        "no_name_only_verification": True, "no_models": True,
        "unknown_outcome_no_retry": True, "manual_conflicts_not_notfound": True,
        "all_catalog_anchors_checked_for_conflicts": True,
        "incomplete_checks_remain_unfinished": True,
        "negative_scope": "Two 10-result web searches, up to three distinct profile captures, all catalog anchors and bounded owned hub followups",
        "not_found_is_protocol_bounded": True,
        "prices": {
            "scrapecreators": {"usd_per_credit_reference": .00188,
                              "quoted_endpoint_credits": 1, "max_reserved_credits": 10,
                              "source": "https://scrapecreators.com/; https://docs.scrapecreators.com/",
                              "actual_account_purchase_price_unknown": True},
            "serper": {"usd_per_query_reference": .001, "source": "https://serper.dev/#pricing",
                       "actual_account_purchase_price_unknown": True},
            "usd_reserved_per_paid_request": .02,
        },
        "source_code_hashes": {p: file_sha(Path(__file__).parent / p) for p in (
            "run_instagram_locked_trial.py", "instagram_trial_extract.py", "instagram_trial_transport.py")},
    }
    save_new(root / "collection-policy.json", policy)
    print(json.dumps({"rows": len(before), "anchors": sum(len(a["anchors"]) for a in before),
                      "incomplete_catalog_inventories": sum(not a["anchor_inventory_complete"] for a in before),
                      "paid_requests": 0}))


def search_candidates(packets):
    rows, seen, ok = [], set(), True
    for packet in packets:
        data = packet.get("data")
        if (packet.get("http_status") != 200 or not isinstance(data, dict)
                or not isinstance(data.get("organic"), list)):
            ok = False
            continue
        for position, hit in enumerate(data["organic"], 1):
            if not isinstance(hit, dict):
                ok = False
                continue
            url = instagram_url(hit.get("link"))
            if not url or url in seen:
                continue
            seen.add(url)
            rows.append({"url": url, "search_receipt_id": packet["request_id"],
                         "rank": hit.get("position", position), "title": hit.get("title"),
                         "snippet": hit.get("snippet"), "discovered_by": "web_search"})
    return rows, ok


def assess(artist, anchors, candidates, progress):
    """Pure explicit-proof rules. All output proof retains receipt lineage."""
    manual, incomplete, proofs, rejected = [], [], [], []
    if not artist.get("anchor_inventory_complete"):
        incomplete.append("CATALOG_INVENTORY_GAPS")
    if not progress.get("searches_complete"):
        incomplete.append("SEARCH_INCOMPLETE")
    by_anchor = {r["anchor_id"]: r for r in anchors}
    if not {a["anchor_id"] for a in artist["anchors"]} <= set(by_anchor):
        incomplete.append("MISSING_ANCHOR_CHECK")
    expected = {identity(a["url"]) for a in artist["anchors"]}
    allowed = {x for x in expected if x and (x[0] in ("spotify", "youtube")
               or (x[0] == "website" and urlsplit(x[2]).hostname not in HUB_HOSTS
                   and any(a["platform"] in ("website", "official_website")
                           and identity(a["url"]) == x for a in artist["anchors"])))}
    handles = {x[2].casefold() for x in expected if x and x[0] in ("twitter", "tiktok")}
    for receipt in anchors:
        if receipt.get("status") != "ok" or not receipt.get("identity_bound"):
            incomplete.append("ANCHOR_UNAVAILABLE_OR_UNBOUND")
            continue
        for url in receipt.get("links", []):
            target = instagram_url(url)
            if target:
                proofs.append({"kind": "artist_page_links_to_instagram",
                               "instagram_url": target, "source_url": receipt["url"],
                               "receipt_id": receipt["receipt_id"],
                               "parent_receipt_id": receipt.get("parent_receipt_id"),
                               "context_fields": receipt["context_fields"],
                               "observed_at": receipt["observed_at"],
                               "capture_sha256": receipt["capture_sha256"]})
        if receipt.get("negative_complete") is not True:
            incomplete.append("ANCHOR_NEGATIVE_LINK_INVENTORY_INCOMPLETE")
    for candidate in candidates:
        url = candidate["url"]
        if candidate.get("status") != "ok" or not candidate.get("identity_bound"):
            incomplete.append("CANDIDATE_CAPTURE_INCOMPLETE")
            rejected.append({"url": url, "reason": candidate.get("reason", "CAPTURE_INCOMPLETE"),
                             "identity_rejection": False})
            continue
        links = candidate.get("links", [])
        observed = {identity(v) for v in links}
        known_spotify = {x for x in expected if x and x[0] == "spotify"}
        other_spotify = {x for x in observed if x and x[0] == "spotify"} - known_spotify
        if known_spotify and other_spotify:
            manual.append("CANDIDATE_POINTS_TO_DIFFERENT_SPOTIFY_ARTIST")
            rejected.append({"url": url, "reason": "CONFLICTING_SPOTIFY_ID", "identity_rejection": False})
            continue
        matches = sorted(allowed & observed)
        handle = urlsplit(url).path.strip("/").casefold()
        if matches or handle in handles:
            proofs.append({"kind": "instagram_catalog_backlink" if matches else "exact_catalog_twitter_tiktok_handle",
                           "instagram_url": url, "source_url": url,
                           "receipt_id": candidate["receipt_id"],
                           "matched_catalog_identities": matches,
                           "matched_handle": handle if handle in handles else None,
                           "hub_receipt_ids": candidate.get("hub_receipt_ids", []),
                           "observed_at": candidate["observed_at"],
                           "capture_sha256": candidate["capture_sha256"]})
        else:
            rejected.append({"url": url, "reason": "NO_EXACT_OWNERSHIP_PROOF",
                             "receipt_id": candidate["receipt_id"], "identity_rejection": False})
        if candidate.get("followups_complete") is not True:
            incomplete.append("CANDIDATE_HUB_CHECK_INCOMPLETE")
    targets = {p["instagram_url"] for p in proofs}
    if len(targets) > 1:
        manual.append("CONFLICTING_PROVEN_INSTAGRAMS")
    if not progress.get("anchor_followups_complete"):
        incomplete.append("ANCHOR_FOLLOWUPS_INCOMPLETE")
    if not progress.get("all_candidates_captured"):
        incomplete.append("CANDIDATE_CAPTURE_LIMIT_OR_MISSING_WORK")
    if manual:
        state = "MANUAL_REVIEW"
    elif incomplete:
        state = "UNFINISHED"
    elif len(targets) == 1:
        state = "VERIFIED"
    else:
        state = "NOT_FOUND"
    return {"state": state, "instagram_url": next(iter(targets)) if state == "VERIFIED" else None,
            "reason_codes": sorted(set(manual + incomplete)) or [
                "EXPLICIT_OWNERSHIP_PROOF" if state == "VERIFIED" else "COMPLETED_PROTOCOL_NO_PROOF"],
            "proof": proofs, "candidates_checked": candidates, "rejected_candidates": rejected}


class Collector:
    def __init__(self, root, transport, policy):
        self.root, self.transport, self.policy = root, transport, policy

    def page(self, artist, anchor, parent=None):
        url = anchor["url"]
        request = provider_request(url)
        if request:
            packet = self.transport.paid(*request)
            extracted = sc_profile(request[0], url, packet)
            receipt_id = packet["request_id"]
            capture_hash = file_sha(self.transport.receipts / (receipt_id + ".json"))
            observed = packet["at"]
        else:
            # Public readers have no authentication, cookies, JS or retries.
            receipt_id = digest({"artist": artist["profile_id"], "anchor": anchor["anchor_id"], "url": url})
            receipt_path = self.transport.receipts / (receipt_id + ".json")
            if receipt_path.exists() and getattr(self.transport, "continuation_public_hashes", None):
                expected = self.transport.continuation_public_hashes.get(receipt_path.name)
                if not expected or file_sha(receipt_path) != expected:
                    raise ValueError("Saved public-page receipt changed or was not admitted")
                packet = json.loads(receipt_path.read_text())
                if packet["source_url"] != safe_url(url):
                    raise ValueError("Saved public-page source identity changed")
            else:
                packet = public_page(url)
                save_new(receipt_path, packet)
            extracted = website_links(packet)
            capture_hash = file_sha(self.transport.receipts / (receipt_id + ".json"))
            observed = packet["at"]
            platform = anchor["platform"]
            if platform not in ("website", "official_website", "bandcamp", "beacons", "owned_hub", "owned_website"):
                raise ValueError("Unsupported public profile parser")
            if platform == "bandcamp" and urlsplit(url).hostname != urlsplit(packet["final_url"]).hostname:
                raise ValueError("Bandcamp identity redirect mismatch")
        return {"anchor_id": anchor["anchor_id"], "url": url, "status": "ok", "identity_bound": True,
                "receipt_id": receipt_id, "capture_sha256": capture_hash, "observed_at": observed,
                "parent_receipt_id": parent, **extracted}

    def collect_artist(self, artist):
        artist = copy.deepcopy(artist)
        searches, candidates, anchors, errors = [], [], [], []
        name = re.sub(r'["\r\n]', " ", artist["artist_name"]).strip()[:200]
        for query in (f'"{name}" musician Instagram site:instagram.com',
                      f'"{name}" official Instagram artist'):
            try:
                searches.append(self.transport.paid("serper", {"q": query, "num": 10}))
            except Exception as e:
                errors.append({"stage": "search", "reason": str(e)})
        discovered, search_ok = search_candidates(searches)
        search_ok = search_ok and len(searches) == 2
        # Check all bound pages, even after a positive match, for conflicts.
        queue = [(a, None) for a in artist["anchors"]]
        seen = {identity(a["url"]) for a in artist["anchors"]}
        followups, anchor_followups_complete = 0, True
        while queue:
            anchor, parent = queue.pop(0)
            try:
                receipt = self.page(artist, anchor, parent)
                anchors.append(receipt)
                # Only explicitly labelled website declarations or profile-owned
                # link hubs become new trusted anchor pages.
                for url in receipt["website_declarations"] + receipt["hub_links"]:
                    ident = identity(url)
                    if ident in seen:
                        continue
                    seen.add(ident)
                    if followups >= self.policy["anchor_followup_bound"]:
                        anchor_followups_complete = False
                        errors.append({"stage": "anchor_followup", "url": url, "reason": "FOLLOWUP_BOUND"})
                        continue
                    followups += 1
                    a = {"url": url, "anchor_id": "followup:" + digest(url)[:20],
                         "platform": "owned_hub" if urlsplit(url).hostname in HUB_HOSTS else "owned_website",
                         "catalog_owned": True}
                    queue.append((a, receipt["receipt_id"]))
                    artist["anchors"].append(a)
            except Exception as e:
                anchors.append({"anchor_id": anchor["anchor_id"], "url": anchor["url"],
                                "status": "failed", "reason": str(e)})
        # Anchor-discovered Instagrams are independently sourced evidence, not
        # an oracle. Give them capture priority without removing search results.
        from_anchor = sorted({u for a in anchors for s in a.get("links", []) if (u := instagram_url(s))})
        all_urls = list(dict.fromkeys(from_anchor + [c["url"] for c in discovered]))
        selected = all_urls[:self.policy["candidate_capture_bound"]]
        for url in selected:
            try:
                handle = urlsplit(url).path.strip("/")
                packet = self.transport.paid("instagram/profile", {"handle": handle})
                extracted = sc_profile("instagram/profile", url, packet)
                receipt_id = packet["request_id"]
                candidate = {"url": url, "status": "ok", "identity_bound": True,
                             "receipt_id": receipt_id, "observed_at": packet["at"],
                             "capture_sha256": file_sha(self.transport.receipts / (receipt_id + ".json")),
                             "followups_complete": True, "hub_receipt_ids": [], **extracted}
                hub_queue, hub_seen = list(candidate["hub_links"]), set()
                while hub_queue:
                    hub = hub_queue.pop(0)
                    if hub in hub_seen:
                        continue
                    hub_seen.add(hub)
                    if len(hub_seen) > 3:
                        candidate["followups_complete"] = False
                        break
                    try:
                        hub_receipt = self.page(artist, {
                            "url": hub, "anchor_id": "candidate-hub:" + digest(url + hub)[:20],
                            "platform": "owned_hub"}, receipt_id)
                        candidate["links"] += hub_receipt["links"]
                        candidate.setdefault("hub_checks", []).append(hub_receipt)
                        candidate["hub_receipt_ids"].append(hub_receipt["receipt_id"])
                        hub_queue += hub_receipt["hub_links"]
                    except Exception as e:
                        candidate["followups_complete"] = False
                        candidate.setdefault("hub_errors", []).append({"url": hub, "reason": str(e)})
                candidates.append(candidate)
            except Exception as e:
                candidates.append({"url": url, "status": "failed", "reason": str(e)})
        progress = {"searches_complete": search_ok, "anchor_followups_complete": anchor_followups_complete,
                    "all_candidates_captured": len(selected) == len(all_urls)}
        decision = assess(artist, anchors, candidates, progress)
        return {k: artist[k] for k in ("profile_id", "cm_artist", "artist_name", "tier", "group")} | {
            "run_id": self.transport.scope["run_id"], "rules_version": RULES, "decided_at": utc(),
            "search_receipt_ids": [p["request_id"] for p in searches],
            "discovered_candidates": discovered,
            "uncaptured_candidate_urls": all_urls[len(selected):],
            "anchor_checks": anchors, "progress": progress, "collection_errors": errors, **decision}


def prepare_continuation(root):
    scope = json.loads((root / "scope.json").read_text())
    parent = json.loads((root / "collection-policy.json").read_text())
    frozen = json.loads((root / "decisions-frozen.json").read_text())
    if parent["inputs_sha256"] != file_sha(root / "inputs.json") or frozen["run_id"] != scope["run_id"]:
        raise ValueError("Continuation scope differs")
    for filename, expected in frozen["hashes"].items():
        if file_sha(root / "artist-results" / filename) != expected:
            raise ValueError("Original frozen outcome changed")
    policy = {
        **parent, "continuation_prepared_at": utc(),
        "parent_policy_sha256": file_sha(root / "collection-policy.json"),
        "parent_frozen_decisions_sha256": file_sha(root / "decisions-frozen.json"),
        "prior_admissions_sha256": file_sha(root / "admissions.jsonl"),
        "changes": [
            "Reuse hash-checked saved provider receipts, including failed-operation tombstones.",
            "Hold acknowledged isolated server/resource failures without stopping unrelated artists.",
            "Keep every original reservation against the same $60 cap; never retry any reserved resource.",
            "Reuse saved public page captures with hash checks.",
            "No decision rules, samples, hidden answer key or per-artist bounds changed.",
        ],
        "prior_receipt_hashes": {p.name: file_sha(p) for p in (root / "receipts").glob("*.json")},
        "source_code_hashes": {p: file_sha(Path(__file__).parent / p) for p in (
            "run_instagram_locked_trial.py", "instagram_trial_extract.py", "instagram_trial_transport.py")},
    }
    save_new(root / "continuation-policy.json", policy)
    print(json.dumps({"continuation": "PREPARED_UNDER_ORIGINAL_60_DOLLAR_APPROVAL",
                      "new_paid_requests": 0, "prior_reserved_usd": frozen["reserved_usd"]}))


def collect(root, continuation=False):
    scope = json.loads((root / "scope.json").read_text())
    policy_path = root / ("continuation-policy.json" if continuation else "collection-policy.json")
    policy = json.loads(policy_path.read_text())
    if continuation and policy["prior_admissions_sha256"] != file_sha(root / "admissions.jsonl"):
        raise ValueError("Spending history changed after continuation preparation")
    if policy["inputs_sha256"] != file_sha(root / "inputs.json") or policy["scope_sha256"] != digest(scope):
        raise ValueError("Frozen inputs/scope changed")
    for filename, expected in policy["source_code_hashes"].items():
        if file_sha(Path(__file__).parent / filename) != expected:
            raise ValueError("Collector source changed after policy freeze")
    inputs = json.loads((root / "inputs.json").read_text())
    if len(inputs) != 200 or Counter(a["group"] for a in inputs) != {"review": 100, "backtest": 100}:
        raise ValueError("Incorrect frozen groups")
    # No hidden reference file is read by this process.
    output = root / ("artist-results-continuation" if continuation else "artist-results")
    output.mkdir(exist_ok=True)
    transport = TrialTransport(root, scope, enabled=True, continuation=continuation)
    if continuation:
        transport.continuation_public_hashes = policy["prior_receipt_hashes"]
    collector = Collector(root, transport, policy)
    counts = Counter()
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = {executor.submit(collector.collect_artist, a): a for a in inputs}
        for future in as_completed(futures):
            a = futures[future]
            try:
                result = future.result()
            except Exception as e:
                result = {**{k: a[k] for k in ("profile_id", "cm_artist", "artist_name", "tier", "group")},
                          "run_id": scope["run_id"], "rules_version": RULES, "state": "UNFINISHED",
                          "reason_codes": ["ARTIST_COLLECTION_EXCEPTION"], "error_type": type(e).__name__,
                          "decided_at": utc(), "proof": [], "instagram_url": None}
            save_new(output / (a["profile_id"] + ".json"), result)
            counts[result["state"]] += 1
            if sum(counts.values()) % 10 == 0 or sum(counts.values()) == 200:
                print(json.dumps({"finished_artists": sum(counts.values()), "counts": dict(counts),
                                  "paid_requests_reserved": transport.request_count,
                                  "reserved_usd": transport.reserved_cents / 100,
                                  "halted": transport.halted.is_set()}), flush=True)
    files = sorted(output.glob("*.json"))
    frozen_name = "decisions-continuation-frozen.json" if continuation else "decisions-frozen.json"
    save_new(root / frozen_name, {
        "run_id": scope["run_id"], "frozen_at": utc(),
        "rows": len(files), "hashes": {p.name: file_sha(p) for p in files},
        "counts": dict(counts), "paid_requests_reserved": transport.request_count,
        "reserved_usd": transport.reserved_cents / 100, "halted": transport.halted.is_set(),
        "note": "Outputs frozen before evaluator-only answer key is opened",
    })
    if continuation:
        save_new(root / "final-output.json", {
            "run_id": scope["run_id"], "results_directory": output.name,
            "decisions_manifest": frozen_name, "policy_file": policy_path.name,
            "decisions_sha256": file_sha(root / frozen_name),
        })


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--prepare", action="store_true")
    group.add_argument("--collect", action="store_true")
    group.add_argument("--prepare-continuation", action="store_true")
    group.add_argument("--continue-collection", action="store_true")
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    if args.prepare:
        finalize_inputs(args.root)
    elif args.prepare_continuation:
        prepare_continuation(args.root)
    else:
        collect(args.root, continuation=args.continue_collection)
