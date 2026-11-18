"""Read-only, blinded input preparation for the approved 100+100 trial.

The locked-link oracle is evaluator-only. The collector receives inputs.json,
not the oracle or the historical selected-Instagram export.
"""
import argparse
import json
import random
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pyarrow.parquet as pq

from instagram_clickhouse_import import Client
from instagram_proof_trial import REVIEW_SEED, digest, identity, instagram_url, safe_url
from prepare_instagram_proof_trial import RECHECK, RECHECK_SHA, SOURCE_SHA, SOURCE, write_new
from run_instagram_recheck import sha

ROOT = Path("generated-artifacts/instagram-proof-trial-locked-100plus100-2026-11-17")
APPROVAL = Path("attached_assets/Pasted-Here-s-how-to-run-the-trial-Answer-key-for-the-back-tes_1794973237109.txt")
RULES = "instagram-explicit-proof-locked-trial-v2"
PLATFORMS = {
    "spotify", "youtube", "twitter", "x", "tiktok", "soundcloud", "bandcamp",
    "website", "official_website", "linktree", "beacons",
}


def read_query(client, query):
    return {"query": query, "observed_at": datetime.now(timezone.utc).isoformat(),
            "rows": client.select(query + " SETTINGS max_execution_time=90,"
                                  "max_result_rows=20000,max_result_bytes=20000000,"
                                  "result_overflow_mode='throw'")}


def prepare():
    if (ROOT / "scope.json").exists():
        raise ValueError("Scope already frozen; never silently resample")
    if sha(RECHECK) != RECHECK_SHA or sha(SOURCE) != SOURCE_SHA:
        raise ValueError("Authoritative review population changed")
    rows = pq.read_table(RECHECK, columns=[
        "profile_id", "cm_artist", "artist_name", "tier", "decision"]).to_pylist()
    assert len(rows) == len({r["profile_id"] for r in rows}) == 48333
    reviews = sorted((r for r in rows if r["decision"] == "review"), key=lambda r: int(r["profile_id"]))
    assert len(reviews) == 31303
    chosen = random.Random(REVIEW_SEED).sample(reviews, 100)
    original_cm = {str(r["cm_artist"]) for r in rows}
    pool = json.loads((ROOT / "locked-reference-pool.evaluator-only.json").read_text())
    ids = [r["cm_artist"] for r in pool["rows"]]
    assert all(str(i).isdigit() for i in ids)
    client = Client()
    mapping = read_query(client,
        "SELECT toString(id) AS profile_id,toString(cm_source_id) AS cm_artist,name AS artist_name "
        "FROM new_vertical.profile FINAL WHERE cm_source='cm_artist' AND deleted_at IS NULL "
        "AND lower(active) IN ('true','1','active') "
        f"AND cm_source_id IN ({','.join(ids)})")
    write_new(ROOT / "control-profile-mapping.json", mapping)
    by_cm = defaultdict(list)
    for r in mapping["rows"]:
        by_cm[r["cm_artist"]].append(r)
    controls, excluded = [], []
    for r in pool["rows"]:
        cm = str(r["cm_artist"])
        truth = sorted({u for value in r["accepted_urls"] if (u := instagram_url(value))})
        if cm in original_cm or len(by_cm[cm]) != 1 or not truth:
            excluded.append({"cm_artist": cm, "reason":
                             "ORIGINAL_COHORT_OR_NOT_ONE_ACTIVE_BOUND_PROFILE_OR_INVALID_LOCKED_URL"})
            continue
        controls.append({**by_cm[cm][0], "accepted_urls": truth, "tier": None})
        if len(controls) == 100:
            break
    assert len(controls) == len({r["profile_id"] for r in controls}) == 100, "Insufficient eligible controls"
    assert not ({r["profile_id"] for r in controls} & {str(r["profile_id"]) for r in chosen})
    oracle = {"reference_label": "agreement with locked catalog links",
              "ownership_independently_confirmed": False, "controls": controls,
              "selection": "First 100 eligible in seeded sipHash64 permutation; no outcome-based replacement",
              "excluded": excluded, "pool_sha256": sha(ROOT / "locked-reference-pool.evaluator-only.json")}
    write_new(ROOT / "oracle.evaluator-only.json", oracle)
    inputs = []
    for group, artists in (("review", chosen), ("backtest", controls)):
        for a in artists:
            inputs.append({"profile_id": str(a["profile_id"]), "cm_artist": str(a["cm_artist"]),
                           "artist_name": a["artist_name"], "tier": a.get("tier"), "group": group})
    assert len(inputs) == len({r["profile_id"] for r in inputs}) == 200
    pids = ",".join(str(int(r["profile_id"])) for r in inputs)
    accounts = read_query(client,
        "SELECT toString(l.profile_id) AS profile_id,toString(a.id) AS account_id,"
        "a.platform,a.handle,a.account_url,a.source "
        "FROM new_vertical.l_profile_account AS l FINAL "
        "INNER JOIN (SELECT id,platform,handle,account_url,source FROM new_vertical.account FINAL "
        "WHERE is_active=1 AND platform!='instagram') a ON l.account_id=a.id "
        f"WHERE l.disconnected_at IS NULL AND l.profile_id IN ({pids})")
    binding = read_query(client,
        "SELECT toString(id) AS profile_id,toString(cm_source_id) AS cm_artist "
        f"FROM new_vertical.profile FINAL WHERE cm_source='cm_artist' AND id IN ({pids})")
    assert {r["profile_id"]: r["cm_artist"] for r in binding["rows"]} == {
        r["profile_id"]: r["cm_artist"] for r in inputs}
    write_new(ROOT / "non-instagram-accounts.json", accounts)
    write_new(ROOT / "profile-binding.json", binding)
    # Preserve all excluded accounts for an honest inventory, without using
    # social names, blue badges or old Instagram verdicts as ownership labels.
    for a in inputs:
        a["anchors"], a["excluded_accounts"] = [], []
        for account in accounts["rows"]:
            if account["profile_id"] != a["profile_id"]:
                continue
            platform = account["platform"].lower()
            url = safe_url(account["account_url"])
            if platform not in PLATFORMS:
                a["excluded_accounts"].append({**account, "reason": "NOT_AN_OWNED_PAGE_PLATFORM_IN_PROTOCOL"})
                continue
            if not url or not identity(url):
                a.setdefault("inventory_gaps", []).append({**account, "reason": "MISSING_OR_UNSUPPORTED_URL"})
                continue
            a["anchors"].append({
                "url": url, "platform": platform, "anchor_id": "account:" + account["account_id"],
                "catalog_owned": True,
                "trust_basis": "USER_APPROVED_CATALOG_ARTIST_ACCOUNT_SEED_NOT_INDEPENDENTLY_AUDITED",
                "provenance": account, "catalog_observed_at": accounts["observed_at"],
            })
        a["anchor_inventory_complete"] = False  # cm_url catalog inventory follows
    write_new(ROOT / "inputs-before-cm-url.json", inputs)
    scope = {
        "run_id": str(uuid.uuid4()), "created_at": datetime.now(timezone.utc).isoformat(),
        "rules_version": RULES, "approval_sha256": sha(APPROVAL),
        "approval_source": str(APPROVAL), "trial_rows": 200, "review_rows": 100, "backtest_rows": 100,
        "max_spend_usd": 60, "max_paid_requests": 3000, "reservation_usd_per_paid_request": .02,
        "max_searches_per_artist": 2, "max_candidate_captures_per_artist": 3,
        "max_anchor_followup_pages_per_artist": 10, "concurrency": 6,
        "method": "SEARCH_AND_CAPTURE_EVERY_ARTIST_PLUS_CATALOG_OWNED_PAGES",
        "reference_label": oracle["reference_label"],
        "full_run_authorized": False, "model_calls_authorized": False,
        "existing_tables_mutable": False, "database": "poc_new_verticals",
        "review_sampling_seed": REVIEW_SEED, "control_sampling_seed": 2026111702,
        "review_population": 31303,
        "hashes": {p.name: sha(p) for p in sorted(ROOT.iterdir()) if p.is_file()},
    }
    scope["scope_sha256"] = digest(scope)
    write_new(ROOT / "scope.json", scope)
    print(json.dumps({"run_id": scope["run_id"], "rows": len(inputs), "groups": [100, 100],
                      "paid_requests": 0, "database_writes": 0}))


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    prepare()
