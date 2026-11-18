"""Read-only preparation. This program has no paid-provider dispatch path."""

import argparse
import csv
import json
import random
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pyarrow.parquet as pq

from instagram_clickhouse_import import Client, SOURCE
from instagram_proof_trial import (
    CONTROL_SEED, MAX_EVIDENCE_AGE_DAYS, MAX_PAID_REQUESTS, MAX_SPEND_CENTS,
    REVIEW_SEED, RULES_VERSION, digest, identity, safe_url,
)
from run_instagram_recheck import sha

RECHECK = Path("generated-artifacts/instagram-recheck-2026-11-17-saved-v2/recheck.parquet")
SOURCE_SHA = "ff768e423005e0abfaa2351d3c37247763490e59cb1bc59c3933ec31f9d1de44"
RECHECK_SHA = "b9d69e472620b3c4b55247d2d5d136df3df9bec429db664b73ba9a7fc9471a70"
OWNED_PLATFORMS = {
    "spotify", "youtube", "twitter", "x", "tiktok", "website", "official_website",
    "soundcloud", "bandcamp", "linktree", "linktr.ee", "beacons", "beacons.ai",
}


def write_new(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)


def choose_review(rows):
    if len(rows) != 48333 or len({r["profile_id"] for r in rows}) != 48333:
        raise ValueError("Selected source cardinality changed")
    pool = sorted((r for r in rows if r["decision"] == "review"),
                  key=lambda r: int(r["profile_id"]))
    if len(pool) != 31303:
        raise ValueError("Review population changed")
    return random.Random(REVIEW_SEED).sample(pool, 200)


def prepare(work):
    if work.exists():
        raise ValueError("Use a fresh preparation directory; never overwrite a frozen scope")
    if sha(SOURCE) != SOURCE_SHA or sha(RECHECK) != RECHECK_SHA:
        raise ValueError("Authoritative saved source changed")
    all_rows = pq.read_table(RECHECK, columns=["profile_id", "cm_artist", "artist_name", "tier", "decision"]).to_pylist()
    chosen = choose_review(all_rows)
    profile_ids = ",".join(str(int(r["profile_id"])) for r in chosen)
    client = Client()
    queries = {
        "profiles": "SELECT toString(id) AS profile_id,toString(cm_source_id) AS cm_artist,"
                    "name,active,toString(deleted_at) AS deleted_at,toString(updated_at) AS updated_at "
                    f"FROM new_vertical.profile FINAL WHERE cm_source='cm_artist' AND id IN ({profile_ids})",
        "accounts": "SELECT toString(l.profile_id) AS profile_id,toString(a.id) AS account_id,"
                    "a.platform,a.handle,a.account_url,a.source,toString(a.modified_at) AS modified_at,"
                    "toString(l.connected_at) AS connected_at FROM new_vertical.l_profile_account AS l FINAL "
                    "INNER JOIN (SELECT id,platform,handle,account_url,source,modified_at "
                    "FROM new_vertical.account FINAL WHERE is_active=1 AND platform!='instagram') a "
                    "ON l.account_id=a.id "
                    f"WHERE l.disconnected_at IS NULL AND l.profile_id IN ({profile_ids})",
        "human_submission_counts": "SELECT internal_verification,verified_by_type,count() AS n,"
                                   "uniqExactIf(profile_id,profile_id IS NOT NULL) AS profiles "
                                   "FROM new_vertical.link_submission FINAL WHERE platform='instagram' "
                                   "GROUP BY internal_verification,verified_by_type",
        "approved_suggestion_counts": "SELECT platform,count() AS n,uniqExact(profile_id) AS profiles "
                                      "FROM poc_new_verticals.profile_social_suggestion "
                                      "WHERE platform='instagram' GROUP BY platform",
        "catalog_url_fields": "SELECT table,name,type FROM system.columns WHERE database='new_vertical' "
                              "AND table IN ('cm_artist','profile_spotify','profile_youtube','profile_tiktok') "
                              "AND match(name,'(?i)url|link|website|biography|description|about|account_id|profile_id') "
                              "ORDER BY table,position",
    }
    packets = {}
    for name, query in queries.items():
        packets[name] = {"query": query, "observed_at": datetime.now(timezone.utc).isoformat(),
                         "rows": client.select(query + " SETTINGS max_execution_time=90,max_result_rows=10000,"
                                               "max_result_bytes=15000000,result_overflow_mode='throw'")}
    profiles = defaultdict(list)
    for row in packets["profiles"]["rows"]:
        profiles[row["profile_id"]].append(row)
    accounts = defaultdict(list)
    for row in packets["accounts"]["rows"]:
        accounts[row["profile_id"]].append(row)
    inputs, gaps, inventory = [], [], Counter()
    for artist in chosen:
        pid = artist["profile_id"]
        bound = profiles[pid]
        if len(bound) != 1 or bound[0]["cm_artist"] != artist["cm_artist"]:
            raise ValueError("Profile/Chartmetric identity changed; stop without replacing the sample")
        anchors, excluded = [], []
        artist_gaps = ["CURRENT_CATALOG_WEBSITE_AND_PROFILE_METADATA_NOT_YET_INVENTORIED",
                       "CATALOG_OWNERSHIP_SOURCE_POLICY_NOT_YET_SEALED"]
        for account in accounts[pid]:
            platform, url = account["platform"].lower(), safe_url(account["account_url"])
            inventory[platform] += 1
            if platform not in OWNED_PLATFORMS:
                excluded.append({**account, "reason": "NOT_AN_APPROVED_OWNED_PAGE_PLATFORM"})
                continue
            if not url or not identity(url):
                artist_gaps.append("LINKED_ACCOUNT_WITH_MISSING_OR_UNSUPPORTED_URL")
                excluded.append({**account, "reason": "MISSING_OR_UNSUPPORTED_URL_NEVER_SILENTLY_SKIPPED"})
                continue
            anchors.append({
                "anchor_id": account["account_id"], "platform": platform, "url": url,
                "catalog_source": account["source"], "relationship_source": "new_vertical.l_profile_account",
                "catalog_observed_at": packets["accounts"]["observed_at"],
                # A catalog association is inventoried, not silently promoted
                # to a newly established artist-owned trust assertion.
                "catalog_owned": False, "trust_status": "AWAITING_SOURCE_POLICY_CONFIRMATION",
            })
        inputs.append({k: artist[k] for k in ("profile_id", "cm_artist", "artist_name", "tier")})
        inputs[-1].update(anchors=anchors, anchor_inventory_complete=False,
                          excluded_catalog_accounts=excluded)
        gaps.append({"profile_id": pid, "reasons": sorted(set(artist_gaps))})
    # Raw snapshots contain no Instagram URLs or candidate-derived model labels.
    # Review cohort selected URLs and old verdicts are deliberately not loaded.
    work.mkdir(parents=True)
    for name, packet in packets.items():
        write_new(work / (name + ".json"), packet)
    write_new(work / "review-source-inputs.json", inputs)
    write_new(work / "preparation-gaps.json", gaps)
    manifest = {
        "run_id": str(uuid.uuid4()), "rules_version": RULES_VERSION,
        "status": "PREPARATION_ONLY_CONTROLS_AND_PAID_APPROVAL_REQUIRED",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "seeds": {"review": REVIEW_SEED, "control": CONTROL_SEED},
        "source_sha256": SOURCE_SHA, "recheck_sha256": RECHECK_SHA,
        "review_profile_ids": [a["profile_id"] for a in inputs],
        "review_rows": 200, "control_rows": 0, "control_population_status": "UNRESOLVED",
        "paid_approval": False, "paid_requests": 0, "model_requests": 0, "database_writes": 0,
        "proposed_limits": {"max_spend_cents": MAX_SPEND_CENTS, "max_paid_requests": MAX_PAID_REQUESTS,
                            "paid_anchor_pages_per_artist": 10, "searches_per_artist": 2,
                            "new_candidate_captures_per_artist": 3,
                            "max_evidence_age_days": MAX_EVIDENCE_AGE_DAYS},
        "inventoried_non_instagram_accounts": dict(inventory),
        "hashes": {p.name: sha(p) for p in sorted(work.iterdir()) if p.is_file()},
    }
    manifest["preparation_sha256"] = digest(manifest)
    write_new(work / "preparation.json", manifest)
    with (work / "review-sample-200.csv").open("x", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=["profile_id", "cm_artist", "artist_name", "tier"])
        writer.writeheader()
        for artist in chosen:
            value = {k: artist[k] for k in writer.fieldnames}
            value["artist_name"] = ("'" + value["artist_name"] if value["artist_name"].startswith(
                ("=", "+", "-", "@")) else value["artist_name"])
            writer.writerow(value)
    print(json.dumps({"review_rows": 200, "control_rows": 0, "paid_requests": 0,
                      "database_writes": 0, "inventory": dict(inventory)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workdir", type=Path, required=True)
    prepare(parser.parse_args().workdir)
