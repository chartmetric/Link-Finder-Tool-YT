"""Evaluator-only reporting, opened only after all sourcing decisions freeze."""
import argparse
import csv
import json
import random
import re
from collections import Counter, defaultdict
from pathlib import Path

from instagram_proof_trial import digest, identity, instagram_url
from instagram_trial_extract import provider_request
from instagram_trial_transport import file_sha, save_new, utc
from adjudicate_instagram_locked_trial import output_paths
from instagram_trial_complete_evidence import complete_audit_row
from prepare_instagram_locked_trial import ROOT


def percent(n, d):
    return round(100 * n / d, 2) if d else None


def evaluate(rows, controls):
    if len(rows) != len({r["profile_id"] for r in rows}) or len(rows) != 200:
        raise ValueError("Exactly 200 distinct frozen outcomes required")
    groups = defaultdict(list)
    for r in rows:
        if r["state"] not in ("VERIFIED", "NOT_FOUND", "MANUAL_REVIEW", "UNFINISHED"):
            raise ValueError("Unknown outcome")
        groups[r["group"]].append(r)
        if r["state"] == "VERIFIED":
            target = instagram_url(r["instagram_url"])
            if not target or not r.get("proof") or any(p["instagram_url"] != target for p in r["proof"]):
                raise ValueError("Verified result has inconsistent or missing explicit proof")
    if {k: len(v) for k, v in groups.items()} != {"review": 100, "backtest": 100}:
        raise ValueError("Both original 100-artist denominators must be preserved")
    if len(controls) != len({r["profile_id"] for r in controls}) or len(controls) != 100:
        raise ValueError("Exactly 100 distinct locked-link controls required")
    oracle = {r["profile_id"]: r for r in controls}
    if set(oracle) != {r["profile_id"] for r in groups["backtest"]}:
        raise ValueError("Hidden control identities differ from frozen backtest")
    matches, different, comparisons = 0, 0, []
    for r in groups["backtest"]:
        known = oracle[r["profile_id"]]
        if known["cm_artist"] != r["cm_artist"]:
            raise ValueError("Control artist binding changed")
        truth = {instagram_url(u) for u in known["accepted_urls"]}
        if not truth or None in truth:
            raise ValueError("Invalid locked-link answer key")
        match = None
        if r["state"] == "VERIFIED":
            match = instagram_url(r["instagram_url"]) in truth
            matches += int(match)
            different += int(not match)
        comparisons.append({**r, "locked_urls": sorted(truth), "matches_locked_link": match})
    stats = {}
    for group, values in groups.items():
        counts = Counter(r["state"] for r in values)
        stats[group] = {"denominator": 100,
                        "counts": {s: counts[s] for s in ("VERIFIED", "NOT_FOUND", "MANUAL_REVIEW", "UNFINISHED")},
                        "percent": {s: percent(counts[s], 100) for s in (
                            "VERIFIED", "NOT_FOUND", "MANUAL_REVIEW", "UNFINISHED")}}
    stats["backtest"].update(
        same_locked_link=matches, different_locked_link=different,
        same_locked_link_percent_all_100=percent(matches, 100),
        different_locked_link_percent_all_100=percent(different, 100),
        agreement_among_verified_percent=percent(matches, matches + different),
        wrongly_not_found=stats["backtest"]["counts"]["NOT_FOUND"],
        wrongly_not_found_percent_all_100=stats["backtest"]["percent"]["NOT_FOUND"],
        reference_label="agreement with locked catalog links",
        independent_ownership_accuracy_established=False,
    )
    return stats, comparisons


def provenance(rows):
    grouped = {}
    for group in ("review", "backtest", "all"):
        values = [r for r in rows if r["state"] == "VERIFIED" and (group == "all" or r["group"] == group)]
        routes, proof_basis = Counter(), Counter()
        for r in values:
            target = r["instagram_url"]
            in_search = target in {c["url"] for c in r.get("discovered_candidates", [])}
            in_anchors = any(p["kind"] == "artist_page_links_to_instagram" for p in r["proof"])
            routes["both" if in_search and in_anchors else "search_only" if in_search else
                   "artist_pages_only" if in_anchors else "other_recorded_route"] += 1
            anchor_proof = any(p["kind"] == "artist_page_links_to_instagram" for p in r["proof"])
            capture_proof = any(p["kind"] != "artist_page_links_to_instagram" for p in r["proof"])
            proof_basis["both" if anchor_proof and capture_proof else
                        "artist_page_outbound_only" if anchor_proof else "instagram_backlink_or_social_handle_only"] += 1
        grouped[group] = {"verified": len(values), "discovery_routes_exclusive": dict(routes),
                          "proof_basis_exclusive": dict(proof_basis)}
    return grouped


def cost_summary(events, rows):
    reserved = [r for r in events if r["event"] == "reserved"]
    ack = [r for r in events if r["event"] == "acknowledged"]
    by_id = {r["request_id"]: r for r in ack}
    if len({r["request_id"] for r in reserved}) != len(reserved) or len(by_id) != len(ack):
        raise ValueError("Duplicate paid admission/acknowledgment")
    counters = Counter()
    credits, searches, unknown = 0, 0, 0
    for r in reserved:
        counters[r["kind"]] += 1
        a = by_id.get(r["request_id"])
        if not a:
            unknown += 1
            continue
        if r["kind"] == "serper":
            searches += 1
        elif a.get("charge_bound_confirmed") and isinstance(a.get("credits_charged"), (float, int)):
            credits += a["credits_charged"]
        else:
            unknown += 1
    dollars = credits * .00188 + searches * .001
    reserved_usd = sum(r["reserved_cents"] for r in reserved) / 100
    # Group costs are attributed by actual source request references. Shared
    # requests are split equally over the artists using the saved resource.
    participants = defaultdict(set)
    for r in rows:
        pid = r["profile_id"]
        # Attribute failed attempts too: normalized successful captures are
        # not the only operations that consumed credits.
        name = re.sub(r'["\r\n]', " ", r["artist_name"]).strip()[:200]
        for q in (f'"{name}" musician Instagram site:instagram.com',
                  f'"{name}" official Instagram artist'):
            participants[digest({"kind": "serper", "params": {"q": q, "num": 10}})].add(pid)
        for key in r.get("search_receipt_ids", []):
            participants[key].add(pid)
        for receipt in r.get("anchor_checks", []) + r.get("candidates_checked", []):
            if receipt.get("receipt_id"):
                participants[receipt["receipt_id"]].add(pid)
            url = receipt.get("url")
            if url:
                if instagram_url(url):
                    request = ("instagram/profile", {"handle": url.rstrip("/").rsplit("/", 1)[-1]})
                else:
                    request = provider_request(url)
                if request:
                    participants[digest({"kind": request[0], "params": request[1]})].add(pid)
            for hub in receipt.get("hub_checks", []):
                participants[hub["receipt_id"]].add(pid)
            for hub in receipt.get("hub_errors", []):
                request = provider_request(hub["url"])
                if request:
                    participants[digest({"kind": request[0], "params": request[1]})].add(pid)
    artist_costs, artist_calls = Counter(), Counter()
    group_kind_calls = defaultdict(Counter)
    artist_group = {r["profile_id"]: r["group"] for r in rows}
    unattributed = 0
    unassigned_operations = 0
    for r in reserved:
        a = by_id.get(r["request_id"], {})
        estimate = (.001 if r["kind"] == "serper" and a else
                    (a.get("credits_charged") or 0) * .00188 if a.get("charge_bound_confirmed") else 0)
        people = participants.get(r["request_id"], set())
        if people:
            for pid in people:
                artist_costs[pid] += estimate / len(people)
                artist_calls[pid] += 1 / len(people)
                group_kind_calls[artist_group[pid]][r["kind"]] += 1 / len(people)
        else:
            unattributed += estimate
            unassigned_operations += 1
    review_cost = sum(artist_costs[r["profile_id"]] for r in rows if r["group"] == "review")
    review_calls = sum(artist_calls[r["profile_id"]] for r in rows if r["group"] == "review")
    return {
        "paid_requests_reserved": len(reserved), "request_counts_by_kind": dict(counters),
        "acknowledged_requests": len(ack), "uncertain_charge_requests": unknown,
        "scrapecreators_acknowledged_credits": credits, "serper_acknowledged_searches": searches,
        "conservative_reserved_usd": round(reserved_usd, 4), "approved_max_usd": 60,
        "estimated_consumption_usd_at_public_reference_prices": round(dollars, 4),
        "reference_price_consumption_range_usd": [
            round(dollars, 4), round(dollars + unknown * .0188, 4)],
        "estimated_usd_per_trial_artist": round(dollars / 200, 6),
        "estimated_review_cohort_usd": round(review_cost, 4),
        "estimated_usd_per_review_artist": round(review_cost / 100, 6),
        "estimated_31303_review_artists_usd_at_observed_effort": round(review_cost / 100 * 31303, 2),
        "conservative_31303_reservation_from_all_trial_average_usd": round(reserved_usd / 200 * 31303, 2),
        "unattributed_estimated_consumption_usd": round(unattributed, 6),
        "unattributed_paid_operations": unassigned_operations,
        "paid_calls_allocated_by_cohort_and_kind": {g: dict(v) for g, v in group_kind_calls.items()},
        "mean_paid_calls_per_review_artist": round(review_calls / 100, 4),
        "estimated_31303_review_paid_calls_at_observed_effort": round(review_calls / 100 * 31303),
        "estimated_31303_review_reservation_usd_at_observed_effort": round(review_calls / 100 * 31303 * .02, 2),
        "limitations": [
            "Consumption is priced using public starter-pack rates, not the private account's invoice or prepaid purchase price.",
            "Missing charge receipts are excluded from the known-consumption estimate; the range retains their full ten-credit allowance.",
            "No new credit purchases or models were used; hosting/compute is excluded.",
            "The full-run extrapolation repeats measured bounded effort, not a promise of complete ownership resolution.",
            "Incomplete artists require further work; no failed/uncaptured item is charged as a completed negative.",
        ],
    }


def csv_write(path, records, fields):
    with path.open("x", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for record in records:
            row = {k: record.get(k) for k in fields}
            for k, v in row.items():
                if isinstance(v, (dict, list)):
                    row[k] = json.dumps(v, ensure_ascii=False)
                elif isinstance(v, str) and v.startswith(("=", "+", "-", "@", "\t", "\r")):
                    row[k] = "'" + v
            w.writerow(row)


def validate_saved_evidence(root, rows):
    events = [json.loads(s) for s in (root / "admissions.jsonl").read_text().splitlines() if s.strip()]
    admissions = [r for r in events if r["event"] == "reserved"]
    keys = {r["request_id"] for r in admissions}
    if len(keys) != len(admissions) or sum(r["reserved_cents"] for r in admissions) > 6000:
        raise ValueError("Duplicate operations or spending ceiling violation")
    for event in events:
        if event["event"] == "acknowledged":
            path = root / "receipts" / (event["request_id"] + ".json")
            if event["request_id"] not in keys or file_sha(path) != event["receipt_sha256"]:
                raise ValueError("Saved paid receipt differs from acknowledgment")
    checked_proofs, checked_captures = 0, 0
    for row in rows:
        checks = list(row.get("anchor_checks", [])) + list(row.get("candidates_checked", []))
        while checks:
            capture = checks.pop()
            checks.extend(capture.get("hub_checks", []))
            if capture.get("receipt_id") and capture.get("capture_sha256"):
                if file_sha(root / "receipts" / (capture["receipt_id"] + ".json")) != capture["capture_sha256"]:
                    raise ValueError("Saved page/profile capture changed after collection")
                checked_captures += 1
        for proof in row.get("proof", []):
            path = root / "receipts" / (proof["receipt_id"] + ".json")
            if not re.fullmatch(r"[0-9a-f]{64}", proof["receipt_id"]):
                raise ValueError("Invalid proof receipt identity")
            if file_sha(path) != proof["capture_sha256"]:
                raise ValueError("Explicit ownership proof lost its captured source")
            if proof.get("parent_receipt_id") and not (
                    root / "receipts" / (proof["parent_receipt_id"] + ".json")).exists():
                raise ValueError("Ownership proof has a missing parent page")
            checked_proofs += 1
        if row["state"] in ("VERIFIED", "NOT_FOUND"):
            if row.get("uncaptured_candidate_urls") or not all(row["progress"].values()):
                raise ValueError("Incomplete checks were incorrectly made terminal")
    return {"unique_paid_operations": len(keys), "duplicate_paid_operations": 0,
            "page_profile_capture_references_verified": checked_captures,
            "ownership_proof_receipts_verified": checked_proofs, "all_saved_paid_receipt_hashes_verified": True}


def report(root):
    frozen_path, results_path, policy_path = output_paths(root)
    frozen = json.loads(frozen_path.read_text())
    if frozen.get("halted"):
        raise ValueError("Trial remains halted; do not unblind an unfinished paid trial")
    scope = json.loads((root / "scope.json").read_text())
    policy = json.loads(policy_path.read_text())
    if (policy["inputs_sha256"] != file_sha(root / "inputs.json")
            or policy["scope_sha256"] != digest(scope)
            or scope["hashes"]["oracle.evaluator-only.json"] != file_sha(root / "oracle.evaluator-only.json")
            or scope["run_id"] != frozen["run_id"]):
        raise ValueError("Frozen inputs, scope or withheld answer key changed")
    inputs = json.loads((root / "inputs.json").read_text())
    rows = []
    for filename, expected in frozen["hashes"].items():
        if not filename.removesuffix(".json").isdigit():
            raise ValueError("Unsafe frozen result filename")
        path = results_path / filename
        if file_sha(path) != expected:
            raise ValueError("Decisions changed before unblinding")
        rows.append(complete_audit_row(root, filename, json.loads(path.read_text())))
    if {r["profile_id"] for r in inputs} != {r["profile_id"] for r in rows}:
        raise ValueError("Missing original sampled artists")
    input_by_id = {r["profile_id"]: r for r in inputs}
    if any(any(row[k] != input_by_id[row["profile_id"]][k] for k in (
            "cm_artist", "artist_name", "group")) for row in rows):
        raise ValueError("Artist metadata or cohort binding changed")
    integrity = validate_saved_evidence(root, rows)
    # First time this process opens the evaluator-only target links.
    oracle = json.loads((root / "oracle.evaluator-only.json").read_text())
    stats, comparisons = evaluate(rows, oracle["controls"])
    events = [json.loads(s) for s in (root / "admissions.jsonl").read_text().splitlines() if s.strip()]
    spend = cost_summary(events, rows)
    if spend["conservative_reserved_usd"] > 60:
        raise ValueError("Budget violation")
    source = provenance(rows)
    verified = sorted((r for r in rows if r["state"] == "VERIFIED"), key=lambda r: int(r["profile_id"]))
    sample = random.Random(2026111703).sample(verified, min(30, len(verified)))
    summary = {
        "run_id": frozen["run_id"], "reported_at": utc(), "metrics": stats,
        "provenance": source, "cost": spend, "evidence_integrity": integrity,
        "manual_sample_requested": 30, "manual_sample_available": len(sample),
        "reason_counts": dict(Counter(code for r in rows for code in r["reason_codes"])),
        "sourcing_inputs_sha256": file_sha(root / "inputs.json"),
        "frozen_decisions_sha256": file_sha(frozen_path),
        "final_results_directory": results_path.name,
        "oracle_sha256": file_sha(root / "oracle.evaluator-only.json"),
        "no_full_run_authorized": True, "historical_tables_changed": False,
    }
    save_new(root / "trial-report.json", summary)
    fields = ["profile_id", "cm_artist", "artist_name", "tier", "group", "instagram_url",
              "state", "reason_codes", "proof", "run_id", "rules_version"]
    csv_write(root / "trial-all-200.csv", rows, fields)
    csv_write(root / "verified-links.csv", verified, fields)
    csv_write(root / "review-verified-links.csv", [r for r in verified if r["group"] == "review"], fields)
    csv_write(root / "verified-random-sample-up-to-30.csv", sample, fields)
    csv_write(root / "backtest-locked-link-comparison.csv", comparisons,
              fields + ["locked_urls", "matches_locked_link"])
    for state in ("NOT_FOUND", "MANUAL_REVIEW", "UNFINISHED"):
        csv_write(root / (state.lower().replace("_", "-") + ".csv"),
                  [r for r in rows if r["state"] == state], fields)
    with (root / "trial-all-200-audit.jsonl").open("x", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    review, backtest = stats["review"], stats["backtest"]
    def metric_line(group):
        return ", ".join(f"{group['counts'][state]} {label} ({group['percent'][state]:g}%)"
                         for state, label in (("VERIFIED", "verified"), ("NOT_FOUND", "not found"),
                                              ("MANUAL_REVIEW", "manual review"),
                                              ("UNFINISHED", "incomplete")))
    route_lines = []
    proof_lines = []
    for group, label in (("review", "Review artists"), ("backtest", "Back-test artists"), ("all", "Total")):
        r = source[group]["discovery_routes_exclusive"]
        p = source[group]["proof_basis_exclusive"]
        route_lines.append(f"| {label} | {r.get('search_only', 0)} | {r.get('artist_pages_only', 0)} | "
                           f"{r.get('both', 0)} | {r.get('other_recorded_route', 0)} |")
        proof_lines.append(f"| {label} | {p.get('artist_page_outbound_only', 0)} | "
                           f"{p.get('instagram_backlink_or_social_handle_only', 0)} | {p.get('both', 0)} |")
    text = f"""# Instagram ownership-proof trial

Run: `{frozen['run_id']}`

## Results
- Review artists (100): {metric_line(review)}.
- Back-test artists (100): {metric_line(backtest)}.
- Agreement with locked catalog links: **{backtest['same_locked_link']}/100** found the same link; **{backtest['different_locked_link']}/100** found a different link.
- Among verified back-test links, agreement was **{backtest['agreement_among_verified_percent']}%**.
- Wrongly marked NOT FOUND against the locked reference: **{backtest['wrongly_not_found']}/100**.
- Incomplete cases are not counted as NOT FOUND. Locked links are the user-approved reference proxy, not independently re-reviewed ownership truth.

## Where verified links came from
Each verified artist counts once. “Both” means the same Instagram was found in search and on an artist page.

| Group | Search only | Artist pages only | Both | Other |
|---|---:|---:|---:|---:|
{chr(10).join(route_lines)}

Finding a link is separate from proving it. The saved proof was:

| Group | Artist's own page links to Instagram | Instagram links back or matches a known social handle | Both |
|---|---:|---:|---:|
{chr(10).join(proof_lines)}

## Cost and scale
- Paid requests reserved: **{spend['paid_requests_reserved']}**; conservative reservation **${spend['conservative_reserved_usd']:.2f}**, against a **$60** approved maximum.
- Estimated consumed value at public reference prices: **${spend['estimated_consumption_usd_at_public_reference_prices']:.4f}**, or **${spend['estimated_usd_per_trial_artist']:.6f} per trial artist**.
- Including the held allowance for missing charge figures, the reference-price consumption range is **${spend['reference_price_consumption_range_usd'][0]:.4f}–${spend['reference_price_consumption_range_usd'][1]:.4f}**.
- Review-cohort average effort extrapolated to 31,303 artists: **${spend['estimated_31303_review_artists_usd_at_observed_effort']:.2f}** at those reference prices.
- Uncertain-charge requests: **{spend['uncertain_charge_requests']}**. Their full reservations remain held; none were retried.
- These are consumption estimates, not the account’s invoice. Actual credit purchase prices are unknown. Hosting/compute is excluded.
- The extrapolation repeats this trial’s bounded work. It does not include the extra work needed to finish incomplete artists and is not a full-run approval.

## Files and limitations
- `trial-all-200.csv`: one row per sampled artist, including incomplete and manual-review cases.
- `verified-links.csv`: only VERIFIED results with explicit saved proof.
- `review-verified-links.csv`: verified review artists only. Back-test artists already have protected catalog links and are evaluation controls, not new port recommendations.
- `verified-random-sample-up-to-30.csv`: **{len(sample)} randomly selected verified rows**{'' if len(sample) == 30 else ' (fewer than 30 were available; no nonverified rows were substituted)'}.
- `backtest-locked-link-comparison.csv`: the post-freeze locked-link comparison.
- `not-found.csv`, `manual-review.csv`, `unfinished.csv`: separate work queues.
- `artist-results/` and `receipts/`: saved checks, searches, candidate captures, rejections, conflicts and access failures.
- Protocol: two 10-result searches per artist, up to {policy['candidate_capture_bound']} distinct candidate captures, every inventoried catalog anchor plus up to ten owned-page followups. Any unexamined candidates or failed required checks leave an incomplete case.
- No name-only matches were verified. No new model calls or credit purchases were made.
- Final rules: `{policy.get('rules_version', 'instagram-explicit-proof-locked-trial-v2')}`. An unrelated rejected candidate is not treated as conflicting ownership evidence against a separately supported link. Genuine contradictory ownership evidence still goes to manual review.
- The 17,030 legacy keeps and all historical source tables were left untouched. No full run was started.
"""
    with (root / "REPORT.md").open("x", encoding="utf-8") as f:
        f.write(text)
    sample_text = ["# Verified Instagram links — random checking sample", "",
                   f"{len(sample)} randomly selected verified links, from the two trial groups combined.",
                   "Full captured proof and source details are in the accompanying CSV and evidence archive.", ""]
    for i, row in enumerate(sample, 1):
        sample_text += [f"## {i}. {row['artist_name']}", "",
                        f"- Artist identifiers: profile_id `{row['profile_id']}`, cm_artist `{row['cm_artist']}`.",
                        f"- Instagram: {row['instagram_url']}", "- Saved proof:"]
        for proof in row["proof"]:
            if proof["kind"] == "artist_page_links_to_instagram":
                explanation = f"The artist's catalog-linked page links to this Instagram: {proof['source_url']}"
            elif proof["kind"] == "instagram_catalog_backlink":
                matched = {tuple(x) for x in proof["matched_catalog_identities"]}
                urls = sorted({url for c in row["candidates_checked"] if c["url"] == row["instagram_url"]
                               for url in c.get("links", []) if identity(url) in matched})
                explanation = "The captured Instagram or its linked bio page links to a known artist page: " + ", ".join(urls)
            else:
                explanation = "The captured Instagram handle exactly matches a catalog-linked Twitter/TikTok handle."
            sample_text.append(f"  - {explanation}. Captured {proof['observed_at']}.")
        sample_text.append("")
    with (root / "VERIFIED-SAMPLE.md").open("x", encoding="utf-8") as f:
        f.write("\n".join(sample_text))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    report(parser.parse_args().root)
