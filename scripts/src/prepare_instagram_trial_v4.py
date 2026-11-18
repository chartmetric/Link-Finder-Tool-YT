"""Prepare a fresh, disjoint 100+100 trial; no paid requests or writes to DB."""
import json
import random
import uuid
from collections import defaultdict
from pathlib import Path

import pyarrow.parquet as pq

from instagram_clickhouse_import import Client
from instagram_proof_trial import digest, identity, instagram_url, safe_url
from instagram_trial_transport import file_sha, save_new, utc
from instagram_trial_v4_rules import RULES
from prepare_instagram_locked_trial import PLATFORMS, read_query
from prepare_instagram_proof_trial import RECHECK, RECHECK_SHA, SOURCE, SOURCE_SHA
from rescore_instagram_trial_v4 import OLD, ROOT as PARENT

ROOT = PARENT / "fresh-trial"
REVIEW_SEED, CONTROL_SEED = 2026111801, 2026111802
TYPES = {"1": "twitter", "3": "youtube", "7": "soundcloud", "14": "spotify",
         "19": "tiktok", "100": "website", "11": "youtube", "23": "youtube"}


def prepare():
    if (ROOT / "scope.json").exists():
        raise ValueError("Fresh trial already frozen; never resample")
    if file_sha(RECHECK) != RECHECK_SHA or file_sha(SOURCE) != SOURCE_SHA:
        raise ValueError("Original review population changed")
    historical = json.loads((OLD / "inputs.json").read_text())
    excluded_profiles = {a["profile_id"] for a in historical}
    excluded_cm = {a["cm_artist"] for a in historical}
    rows = pq.read_table(RECHECK, columns=[
        "profile_id", "cm_artist", "artist_name", "tier", "decision"]).to_pylist()
    assert len(rows) == 48333 and len({str(r["profile_id"]) for r in rows}) == 48333
    reviews = sorted((r for r in rows if r["decision"] == "review"
                      and str(r["profile_id"]) not in excluded_profiles
                      and str(r["cm_artist"]) not in excluded_cm),
                     key=lambda r: int(r["profile_id"]))
    review_pool = random.Random(REVIEW_SEED).sample(reviews, min(500, len(reviews)))
    pool = json.loads((ROOT / "locked-reference-pool.evaluator-only.json").read_text())
    original_cm = {str(r["cm_artist"]) for r in rows}
    cms = {str(r["cm_artist"]) for r in review_pool + pool["rows"]}
    assert all(i.isdigit() for i in cms)
    client = Client()
    mapping = read_query(client,
        "SELECT toString(id) AS profile_id,toString(cm_source_id) AS cm_artist,name AS artist_name "
        "FROM new_vertical.profile FINAL WHERE cm_source='cm_artist' AND deleted_at IS NULL "
        "AND lower(active) IN ('true','1','active') "
        f"AND cm_source_id IN ({','.join(sorted(cms, key=int))})")
    save_new(ROOT / "active-profile-mapping.json", mapping)
    by_cm = defaultdict(list)
    for row in mapping["rows"]:
        by_cm[row["cm_artist"]].append(row)
    chosen, controls, exclusions = [], [], []
    for row in review_pool:
        cm, pid = str(row["cm_artist"]), str(row["profile_id"])
        mapped = by_cm[cm]
        if len(mapped) == 1 and mapped[0]["profile_id"] == pid:
            chosen.append({**row, "profile_id": pid, "cm_artist": cm})
        else:
            exclusions.append({"profile_id": pid, "group": "review", "reason": "NO_UNIQUE_CURRENT_BINDING"})
        if len(chosen) == 100:
            break
    for row in pool["rows"]:
        cm = str(row["cm_artist"])
        truth = sorted({u for s in row["accepted_urls"] if (u := instagram_url(s))})
        mapped = by_cm[cm]
        if (cm in original_cm or cm in excluded_cm or len(mapped) != 1 or not truth
                or mapped[0]["profile_id"] in excluded_profiles):
            exclusions.append({"cm_artist": cm, "group": "backtest",
                               "reason": "PRIOR_COHORT_OR_NO_UNIQUE_BOUND_REFERENCE"})
            continue
        controls.append({**mapped[0], "accepted_urls": truth, "tier": None})
        if len(controls) == 100:
            break
    assert len(chosen) == len(controls) == 100
    save_new(ROOT / "oracle.evaluator-only.json", {
        "reference_label": "agreement with locked catalog links",
        "ownership_independently_confirmed": False, "controls": controls,
        "pool_sha256": file_sha(ROOT / "locked-reference-pool.evaluator-only.json"),
        "sampling_seed": CONTROL_SEED, "selection_exclusions": exclusions})
    inputs = [{k: a.get(k) for k in ("profile_id", "cm_artist", "artist_name", "tier")} |
              {"group": group} for group, artists in (("review", chosen), ("backtest", controls))
              for a in artists]
    assert len(inputs) == len({r["profile_id"] for r in inputs}) == len({r["cm_artist"] for r in inputs}) == 200
    assert not ({r["profile_id"] for r in inputs} & excluded_profiles)
    assert not ({r["cm_artist"] for r in inputs} & excluded_cm)
    pids = ",".join(str(int(r["profile_id"])) for r in inputs)
    accounts = read_query(client,
        "SELECT toString(l.profile_id) AS profile_id,toString(a.id) AS account_id,"
        "a.platform,a.handle,a.account_url,a.source "
        "FROM new_vertical.l_profile_account AS l FINAL "
        "INNER JOIN (SELECT id,platform,handle,account_url,source FROM new_vertical.account FINAL "
        "WHERE is_active=1 AND lower(platform)!='instagram' "
        "AND positionCaseInsensitive(ifNull(account_url,''),'instagram.com')=0) a ON l.account_id=a.id "
        f"WHERE l.disconnected_at IS NULL AND l.profile_id IN ({pids})")
    save_new(ROOT / "non-instagram-accounts.json", accounts)
    for artist in inputs:
        artist["anchors"], artist["excluded_accounts"] = [], []
        for account in accounts["rows"]:
            if account["profile_id"] != artist["profile_id"]:
                continue
            platform, url = account["platform"].lower(), safe_url(account["account_url"])
            if platform not in PLATFORMS:
                artist["excluded_accounts"].append({**account, "reason": "NOT_A_SUPPORTED_ARTIST_PAGE"})
                continue
            if not url or not identity(url):
                artist.setdefault("inventory_gaps", []).append({**account, "reason": "INVALID_CATALOG_URL"})
                continue
            artist["anchors"].append({
                "url": url, "platform": platform, "anchor_id": "account:" + account["account_id"],
                "catalog_owned": True, "trust_basis": "USER_APPROVED_CATALOG_SEED_NOT_INDEPENDENTLY_AUDITED",
                "provenance": account, "catalog_observed_at": accounts["observed_at"]})
        artist["anchor_inventory_complete"] = False
    save_new(ROOT / "inputs-before-cm-url.json", inputs)
    approval = ROOT / "approval.txt"
    scope = {
        "run_id": str(uuid.uuid4()), "created_at": utc(), "rules_version": RULES,
        "approval_source": str(approval), "approval_sha256": file_sha(approval),
        "approval_kind": "USER_DIRECT_CHAT_INSTRUCTION_TRANSCRIBED_VERBATIM",
        "trial_rows": 200, "review_rows": 100, "backtest_rows": 100,
        "max_spend_usd": 20, "full_run_authorized": False, "model_calls_authorized": False,
        "database": "poc_new_verticals", "existing_tables_mutable": False,
        "review_sampling_seed": REVIEW_SEED, "control_sampling_seed": CONTROL_SEED,
        "prior_cohort_sha256": file_sha(OLD / "inputs.json"),
        "review_pool_excluding_prior": len(reviews), "no_outcome_based_replacement": True,
        "max_candidate_captures_per_artist": 50, "max_anchor_followup_pages_per_artist": 10,
        "max_paid_requests": 4000, "concurrency": 6,
        "proof_overrides_unfinished_checks": True, "actual_conflicts_require_manual_review": True,
        "budget_accounting": {
            "currency": "USD", "integer_unit": "microdollar",
            "scrapecreators_max_credits_per_request": 10,
            "scrapecreators_guard_usd_per_credit": .004,
            "scrapecreators_reference_usd_per_credit": .00188,
            "serper_guard_usd_per_query": .002, "serper_reference_usd_per_query": .001,
            "method": "Reserve the maximum before dispatch; settle only acknowledged known credits. Unknown/failed charges retain the full reservation. No replay.",
            "actual_account_purchase_price_unknown": True,
        },
    }
    save_new(ROOT / "scope.json", scope)
    print(json.dumps({"rows": 200, "run_id": scope["run_id"], "paid_requests": 0,
                      "old_cohort_overlap": 0, "database_writes": 0}))


def finalize():
    inputs = json.loads((ROOT / "inputs-before-cm-url.json").read_text())
    catalog = json.loads((ROOT / "cm-url-non-instagram.json").read_text())
    for artist in inputs:
        known = {identity(a["url"]): a for a in artist["anchors"]}
        for row in catalog["rows"]:
            if row["cm_artist"] != artist["cm_artist"]:
                continue
            url = safe_url(row["url"])
            ident = identity(url)
            if row["type"] in ("11", "23") and (not ident or ident[0] != "youtube"):
                artist["excluded_accounts"].append({**row, "reason": "NOT_A_CANONICAL_ARTIST_YOUTUBE_PROFILE"})
                continue
            if not url or not ident or instagram_url(url):
                artist.setdefault("inventory_gaps", []).append({**row, "reason": "INVALID_CM_URL"})
                continue
            if ident in known:
                known[ident].setdefault("additional_catalog_provenance", []).append(row)
            else:
                known[ident] = {
                    "url": url, "platform": TYPES[row["type"]], "anchor_id": "cm_url:" + row["cm_url_id"],
                    "catalog_owned": True, "trust_basis": "USER_APPROVED_CATALOG_SEED_NOT_INDEPENDENTLY_AUDITED",
                    "provenance": row, "catalog_observed_at": catalog["observed_at"]}
        artist["anchors"] = list(known.values())
        artist["anchor_inventory_complete"] = not bool(artist.get("inventory_gaps"))
    save_new(ROOT / "inputs.json", inputs)
    scope = json.loads((ROOT / "scope.json").read_text())
    code = ("instagram_trial_v4_rules.py", "instagram_trial_v4_sources.py",
            "instagram_trial_v4_transport.py", "run_instagram_trial_v4.py",
            "rescore_instagram_trial_v4.py", "instagram_proof_trial.py",
            "run_instagram_locked_trial.py", "instagram_trial_extract.py",
            "instagram_trial_transport.py")
    snapshots = ROOT / "source-snapshots"
    snapshots.mkdir()
    for name in code:
        with (snapshots / name).open("xb") as stream:
            stream.write((Path(__file__).parent / name).read_bytes())
    save_new(ROOT / "collection-policy.json", {
        "run_id": scope["run_id"], "rules_version": RULES, "prepared_at": utc(),
        "inputs_sha256": file_sha(ROOT / "inputs.json"), "scope_sha256": digest(scope),
        "source_code_hashes": {p: file_sha(Path(__file__).parent / p) for p in code},
        "candidate_capture_bound": 50, "anchor_followup_bound": 10,
        "two_searches_per_artist": True, "no_name_only_verification": True,
        "proof_first_positive_terminal_unless_actual_conflict": True,
        "unknown_outcomes_never_retried": True, "full_run_authorized": False,
    })
    print(json.dumps({"finalized": 200, "paid_requests": 0}))


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--finalize", action="store_true")
    args = parser.parse_args()
    finalize() if args.finalize else prepare()
