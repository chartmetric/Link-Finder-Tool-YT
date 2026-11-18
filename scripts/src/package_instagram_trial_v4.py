"""Readable comparison, review CSVs and one checksum-verified data download."""
import csv
import hashlib
import json
import random
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

from instagram_proof_trial import instagram_url
from instagram_trial_transport import file_sha, save_new
from prepare_instagram_trial_v4 import ROOT


def table_line(label, measured):
    result = []
    for group in ("review", "backtest"):
        m = measured[group]
        result.append(f"| {label} | {group} | {m['VERIFIED']} | {m['NOT_FOUND']} | "
                      f"{m['MANUAL_REVIEW']} | {m['UNFINISHED']} |")
    return "\n".join(result)


def discovery_routes(rows):
    counts = defaultdict(Counter)
    for row in rows:
        if row["state"] != "VERIFIED":
            continue
        target = row["instagram_url"]
        search = target in {c["url"] for c in row["discovered_candidates"]}
        artist = target in {
            instagram_url(u) for a in row["anchor_checks"] if a["status"] == "ok"
            for u in a.get("links", [])}
        route = "both" if search and artist else "search_only" if search else "artist_pages_only" if artist else "unclassified"
        counts[row["group"]][route] += 1
    return {k: dict(v) for k, v in counts.items()}


def package():
    parent = ROOT.parent
    replay = json.loads((parent / "saved-evidence-rescore" / "before-after.json").read_text())
    fresh = json.loads((ROOT / "trial-report.json").read_text())
    publication = json.loads((parent / "publication" / "DATA-LOCATION.json").read_text())
    rows = [json.loads(s) for s in (ROOT / "fresh-all-200-audit.jsonl").read_text().splitlines()]
    fresh_routes = discovery_routes(rows)
    replay_rows = [json.loads(s) for s in
                   (parent / "saved-evidence-rescore" / "rescored-all-200-audit.jsonl").read_text().splitlines()]
    replay_routes = discovery_routes(replay_rows)
    verified = sorted((r for r in rows if r["state"] == "VERIFIED"), key=lambda r: int(r["profile_id"]))
    sample = random.Random(2026111803).sample(verified, min(30, len(verified)))
    columns = ["profile_id", "cm_artist", "artist_name", "tier", "group", "instagram_url", "rules_version"]
    for filename, values in (
        ("fresh-verified-random-sample.csv", sample),
        ("fresh-verified-all.csv", verified),
        ("fresh-review-verified-links.csv", [r for r in verified if r["group"] == "review"]),
    ):
        with (ROOT / filename).open("x", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=columns + ["proof", "unfinished_checks", "production_port_authorized"])
            writer.writeheader()
            for row in values:
                writer.writerow({**{k: row.get(k) for k in columns},
                                 "proof": json.dumps(row["proof"], ensure_ascii=False),
                                 "unfinished_checks": json.dumps(row.get("unfinished_checks", [])),
                                 "production_port_authorized": "false"})
    costs, measured, targets = fresh["costs"], fresh["metrics"], fresh["targets"]
    review_cost = costs["reference_known_consumption_by_group_usd"]["review"] / 100
    save_new(parent / "SUPPLEMENTARY-METRICS.json", {
        "fresh_discovery_routes": fresh_routes, "saved_rescore_discovery_routes": replay_routes,
        "route_definition": "Where the selected URL was observed: paid search results, artist-page captures, or both. Not separate exclusive proof types.",
        "fresh_review_cost_per_artist_reference_usd": review_cost,
        "rough_all_31303_review_artists_reference_usd": review_cost * 31303,
        "estimate_is_not_a_spending_authorization": True,
        "forecast_warning": "Same-workload extrapolation at reference credit prices; source-rule fixes may change workload. Not an invoice quote.",
    })
    agreement = measured["agreement_with_locked_catalog_links"]
    after = replay["after"]["agreement_with_locked_catalog_links"]
    passed = targets["agreement_at_least_95pct"] and targets["wrong_not_found_at_most_5pct"]
    lines = [
        "# Instagram proof-first rules and fresh trial",
        "",
        "The old results were preserved. The first comparison below reuses saved evidence "
        "and cost nothing in new provider calls. It is a development replay, not a fresh accuracy test.",
        "",
        "## Results",
        "Each group below contains exactly 100 artists.",
        "",
        "| Trial | Group | Verified | Not found | Manual review | Incomplete |",
        "|---|---|---:|---:|---:|---:|",
        table_line("Original", replay["before"]),
        table_line("Saved evidence, revised rules", replay["after"]),
        table_line("Fresh, revised rules", measured),
        "",
        "## Agreement with locked catalog links",
        "This is agreement with the protected catalog reference, not independently established ownership accuracy.",
        "",
        "| Trial | Same link | Different link | Agreement among verified back-test links | Wrong NOT_FOUND out of 100 |",
        "|---|---:|---:|---:|---:|",
    ]
    for label, data in (
        ("Original", replay["before"]["agreement_with_locked_catalog_links"]),
        ("Saved replay", after), ("Fresh", agreement),
    ):
        pct = data["agreement_pct_of_verified"]
        shown = f"{pct}%" if pct is not None else "Not measurable"
        lines.append(f"| {label} | {data['same']} | {data['different']} | "
                     f"{shown} | {data['wrong_not_found']} |")
    lines += [
        "",
        f"Fresh trial target of at least 95% agreement: {'MET' if targets['agreement_at_least_95pct'] else 'NOT MET'}.",
        f"Fresh trial target of at most 5% wrongly NOT_FOUND: {'MET' if targets['wrong_not_found_at_most_5pct'] else 'NOT MET'}.",
        f"Both numerical targets: {'MET IN THIS SAMPLE' if passed else 'NOT MET'}.",
        f"Collection halted: {str(targets['collection_halted']).lower()}.",
        "Passing these sample thresholds is not a guarantee for every artist. "
        "Manual and incomplete cases remain visible; they are not counted as correct negatives.",
        "",
        "## What changed",
        "- Observed conflicting ownership evidence still requires manual review.",
        "- One qualifying ownership proof now means VERIFIED even when other checks failed or remain unfinished.",
        "- Unfinished checks are retained in each verified row's audit rather than discarded.",
        "- Explicit Instagram account declarations in known artist biographies/descriptions are read, "
        "as well as full URLs, www URLs, declared artist websites/hubs and identity-bound channel aliases.",
        "- Names, badges and search scores never count as ownership proof.",
        "- Newly recognized but unexamined link pages leave a proofless artist incomplete, not NOT_FOUND.",
        "",
        "## The seven captured misses",
        "See saved-evidence-rescore/SEVEN-CAPTURED-MISSES.txt for every case.",
        "- Gracenote: the known YouTube description explicitly declared @gracenotejam.",
        "- Rafi Bastos: Instagram and the known TikTok pointed to the exact same declared website.",
        "- VSpence and king Zeus: missing link-page checks now leave the artist incomplete; this does not verify either account.",
        "- Lickz, Camion Bazar and Bassolino: the saved material did not provide the required independently known account/page connection.",
        "- The eighth missed artist, Light V Dark, never had the right Instagram captured.",
        "The decrease from eight to four wrong NOT_FOUND cases is two recovered proofs plus two honest incomplete outcomes, "
        "not four newly proven links.",
        "",
        "## Why the full run remains paused",
        "The fresh trial missed the 95% agreement target: 60 of 66 verified controls matched, or 90.9%. "
        "All six disagreements remain counted; no locked reference or frozen prediction was changed.",
        "- One clear error: Vandenberg's MoonKings was linked to Mascot Label Group's Instagram "
        "because a catalog-associated label YouTube was incorrectly treated as the artist's own channel.",
        "- Five other selections have Spotify/YouTube page evidence but differ from the locked reference. "
        "They may be alternate or updated accounts; they are not assumed correct.",
        "- Of the five fresh wrong NOT_FOUND controls, three correct accounts were not captured. "
        "Two were captured but lacked the required independent artist connection.",
        "Next: validate source-page ownership rather than trusting catalog association alone, "
        "and review the six disagreements and five misses before scaling. "
        "See fresh-trial/POST-TRIAL-OBSERVATIONS.txt and the two targeted diagnostic CSVs.",
        "All new table rows are marked with the failed trial gate and production_port_authorized=false. "
        "The CSVs contain trial predictions, not an approved production import. "
        "The grandfathered 17,030 keep rows were not changed.",
        "",
        "## Fresh-trial cost",
        f"- Distinct paid requests: {costs['paid_requests']}. Duplicate paid admissions: {costs['duplicate_paid_admissions']}.",
        f"- Estimated consumed credit value at published reference prices: "
        f"${costs['reference_consumption_low_usd']:.4f}–${costs['reference_consumption_high_usd']:.4f}.",
        f"- Estimated cost per sampled artist: "
        f"${costs['reference_cost_per_artist_low_usd']:.5f}–${costs['reference_cost_per_artist_high_usd']:.5f}.",
        f"- Fresh review-group estimate: ${review_cost:.5f} per artist; roughly "
        f"${review_cost * 31303:,.2f} for all 31,303 review artists at the same workload and reference prices.",
        "That extrapolation is not a quote or spending approval; the required source-ownership fixes may change the cost.",
        f"- Conservative guarded liability: ${costs['guarded_liability_usd']:.4f}, within the $20 approved ceiling.",
        f"- Requests with uncertain charge figures: {costs['unknown_charge_requests']}; maximum reservations were retained.",
        "Known acknowledged credit usage was settled in the new ledger; unknown charges were never released or retried. "
        "The closed prior trial's allowance was not reused.",
        "These are provider credit-value estimates, not an account invoice. Actual credit purchase prices are unknown; "
        "hosting and agent runtime are not included.",
        "",
        "## Where verified URLs were discovered",
        "A URL can appear in both search results and artist-page captures. These mutually exclusive buckets "
        "describe discovery, not different standards of proof.",
        "",
        "| Phase | Group | Search only | Artist pages only | Both | Unclassified |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for phase, routes in (("Saved replay", replay_routes), ("Fresh", fresh_routes)):
        for group in ("review", "backtest"):
            d = routes.get(group, {})
            lines.append(f"| {phase} | {group} | {d.get('search_only', 0)} | "
                         f"{d.get('artist_pages_only', 0)} | {d.get('both', 0)} | {d.get('unclassified', 0)} |")
    lines += [
        "",
        "## Fresh sampling and safety",
        "- 100 review artists and 100 locked-link controls, with no artist/profile overlap with the first trial.",
        "- Review artists came from the remaining saved review population, conditional on a current unique active catalog binding.",
        "- Controls came from the seeded locked, active catalog-link population with a unique active New Verticals profile. "
        "They are evaluation controls, not new port recommendations.",
        "- Two web searches per artist, candidate captures and available catalog-owned pages; shared exact provider resources were captured once.",
        "- Back-test Instagram URLs stayed out of collection inputs. Predictions and evidence were frozen before evaluation.",
        "- No new model calls. No existing tables or live links were changed.",
        "- No full run has started. It still requires the user's separate approval.",
        "",
        "## New saved tables",
    ]
    for item in publication["tables"]:
        lines.append(f"- {item['table']}: {item['rows']} rows; content hashes verified after insertion.")
    lines += [
        "The results table separates saved_rescore and fresh phases, 200 artists each. "
        "source_run_id preserves capture provenance; run_id identifies this evaluation.",
        "",
        "## Files",
        "- fresh-trial/fresh-all-200.csv: all fresh results, one row per artist.",
        "- saved-evidence-rescore/rescored-all-200.csv: before/after outcomes for the original artists.",
        "- fresh-trial/fresh-review-verified-links.csv: new review-artist verified links only.",
        "- fresh-trial/fresh-verified-random-sample.csv: random verified sample from both fresh groups, with proof.",
        "- fresh-trial/backtest-comparison.csv: locked-reference comparison.",
        "- Audit JSONL, saved receipts, scope, rules hashes, cost data and publication records are included.",
        "- original-trial-complete.zip preserves all files from the original trial.",
        "- NOT_FOUND means no qualifying proof within the completed protocol, not proof that an Instagram account does not exist.",
        "- Source-code snapshots remain in the project; their hashes are included in the trial policy.",
        "- CSVs retain public artist text. Import text columns as text rather than spreadsheet formulas; "
        "Parquet files preserve the raw values without formula evaluation.",
    ]
    text = "\n".join(lines) + "\n"
    with (parent / "RESPONSE-AND-REPORT.txt").open("x") as stream:
        stream.write(text)
    with (parent / "RESPONSE-AND-REPORT.md").open("x") as stream:
        stream.write(text)
    save_new(parent / "COMPARISON.json", {
        "saved_before": replay["before"], "saved_after": replay["after"], "fresh": measured,
        "fresh_costs": costs, "fresh_targets": targets, "full_run_authorized": False,
    })
    archive = Path("generated-artifacts/instagram-proof-first-v4-trials-2026-11-18.zip")
    files = [(p, p.relative_to(parent).as_posix()) for p in parent.rglob("*")
             if p.is_file() and "source-snapshots" not in p.parts and p.suffix != ".lock"]
    original = Path("generated-artifacts/instagram-trial-complete-with-summary-2026-11-17.zip")
    files.append((original, "original-trial-complete.zip"))
    manifest = [{"path": name, "bytes": path.stat().st_size, "sha256": file_sha(path)}
                for path, name in files]
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for path, name in files:
            bundle.write(path, name)
        bundle.writestr("MANIFEST.json", json.dumps(manifest, indent=2))
    with zipfile.ZipFile(archive) as bundle:
        if bundle.testzip() is not None:
            raise ValueError("Download archive failed integrity check")
    if archive.stat().st_size > 100 * 1024 * 1024:
        raise ValueError("Archive exceeds Library limit; split losslessly before delivery")
    print(json.dumps({"zip": str(archive), "MiB": round(archive.stat().st_size / 1024**2, 2),
                      "sample_verified": len(sample), "fresh_targets": targets}))


if __name__ == "__main__":
    package()
