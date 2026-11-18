"""Saved-data recheck: collect stored catalog facts, score offline, publish once."""

import argparse
import csv
import hashlib
import io
import json
import random
import re
import shutil
import sys
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from instagram_clickhouse_import import Client, SOURCE
from instagram_recheck_rules import RULES_VERSION, recheck

TABLE = "poc_new_verticals.musician_instagram_recheck"
EXPECTED_SOURCE_SHA = "ff768e423005e0abfaa2351d3c37247763490e59cb1bc59c3933ec31f9d1de44"
SEED = 20261117
RULES = Path(__file__).with_name("instagram_recheck_rules.py")
INPUT_COLUMNS = [
    "profile_id", "cm_artist", "artist_name", "tier", "selected_url", "selected_handle",
    "source_batch_id", "rules_version", "scrapecreators_full_name", "scrapecreators_biography",
    "scrapecreators_external_urls_json", "scrapecreators_bio_link_urls_json",
    "scrapecreators_bio_link_page_urls_json", "scrapecreators_category", "capture_status",
    "catalog_spotify_artist_ids_json", "catalog_youtube_urls_json", "catalog_tiktok_urls_json",
    "catalog_twitter_urls_json", "catalog_accounts_used_json",
]
STRING_COLUMNS = [
    "profile_id", "cm_artist", "artist_name", "selected_url", "selected_handle", "display_name",
    "source_batch_id", "source_rules_version", "rules_version", "run_id", "decision",
    "reason_codes_json", "qualifying_match_codes_json", "check_statuses_json", "data_gaps_json",
    "normalized_artist_name", "normalized_display_name", "normalized_handle_name",
    "rule_evidence_json", "catalog_context_json", "source_row_sha256", "rules_sha256",
]
SCHEMA = pa.schema([pa.field(name, pa.string(), nullable=False) for name in STRING_COLUMNS]
                   + [pa.field("tier", pa.int64(), nullable=False)])
CH_SCHEMA = [(name, "String") for name in STRING_COLUMNS] + [("tier", "Int64")]


def text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2))


def deny_network():
    def guard(event, args):
        if event in ("socket.connect", "socket.getaddrinfo", "subprocess.Popen", "os.system"):
            raise RuntimeError("Offline recheck cannot make provider/network/process calls")
    sys.addaudithook(guard)


def source_rows():
    assert sha(SOURCE) == EXPECTED_SOURCE_SHA, "Historical source changed"
    return pq.read_table(SOURCE, columns=INPUT_COLUMNS).to_pylist()


def existing_target(client):
    return client.select("SELECT name FROM system.tables WHERE database='poc_new_verticals' "
                         "AND name='musician_instagram_recheck'")


def collect(work):
    assert not work.exists(), "Choose a fresh run directory; never overwrite a snapshot"
    client = Client()
    assert not existing_target(client), "Recheck table already exists; stop without overwriting"
    rows = source_rows()
    assert len(rows) == len({r["profile_id"] for r in rows}) == 48333
    source_count = client.select("SELECT count() AS n,uniqExact(profile_id) AS profiles "
                                 "FROM poc_new_verticals.musician_instagram_selected")[0]
    assert int(source_count["n"]) == int(source_count["profiles"]) == 48333
    work.mkdir(parents=True)
    manifest = {"run_id": str(uuid.uuid4()), "rules_version": RULES_VERSION,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "source_sha256": EXPECTED_SOURCE_SHA, "rules_sha256": sha(RULES),
                "target": TABLE, "provider_calls": 0, "model_calls": 0, "status": "collecting_stored_catalog"}
    save(work / "manifest.json", manifest)
    profiles = "SELECT toUInt32(profile_id) FROM poc_new_verticals.musician_instagram_selected"
    artists = "SELECT toUInt32(cm_artist) FROM poc_new_verticals.musician_instagram_selected"
    queries = {
        "profiles": "SELECT toString(id) AS profile_id,toString(cm_source_id) AS cm_artist,"
                    "name,toString(updated_at) AS updated_at FROM new_vertical.profile FINAL "
                    f"WHERE id IN ({profiles}) AND cm_source='cm_artist'",
        "genres": "SELECT toString(cm_artist) AS cm_artist,"
                  "groupUniqArray(tuple(tag_slug,source,toString(created_at))) AS tags "
                  f"FROM new_vertical.l_cm_artist_tag WHERE tag_type='genre' AND cm_artist IN ({artists}) "
                  "GROUP BY cm_artist",
        "tracks": "SELECT toString(c.cm_artist) AS cm_artist,"
                  "groupUniqArray(tuple(toString(c.cm_track),t.name,toString(c.release_date))) AS tracks FROM "
                  "(SELECT cm_artist,cm_track,min(track_rank) AS rank,max(release_date) AS release_date "
                  f"FROM new_vertical.prioritised_artist_track_tier_cache WHERE cm_artist IN ({artists}) "
                  "GROUP BY cm_artist,cm_track ORDER BY cm_artist,rank,cm_track LIMIT 20 BY cm_artist) c "
                  "INNER JOIN (SELECT id,name FROM new_vertical.cm_track FINAL WHERE id IN "
                  "(SELECT cm_track FROM new_vertical.prioritised_artist_track_tier_cache "
                  f"WHERE cm_artist IN ({artists}))) t ON t.id=c.cm_track GROUP BY c.cm_artist",
    }
    for name, query in queries.items():
        # These are existing stored catalog facts, not new captures. Do not use
        # candidate-derived profile metadata or infer musical language from country.
        query += " SETTINGS max_execution_time=120,max_result_rows=1000000,max_result_bytes=150000000,result_overflow_mode='throw'"
        result = client.select(query)
        packet = {"source": "read_only_existing_clickhouse_catalog",
                  "observed_at": datetime.now(timezone.utc).isoformat(), "query": query, "rows": result}
        save(work / (name + ".json"), packet)
        print(text({"stored_catalog_source": name, "rows": len(result)}), flush=True)
    manifest["status"] = "stored_catalog_frozen"
    manifest["context_hashes"] = {name: sha(work / (name + ".json")) for name in queries}
    save(work / "manifest.json", manifest)


def reviewed_profiles():
    """Known human feedback and conservative exclusion of prior IG sample exports."""
    exclusions = defaultdict(set)
    # Explicit artist IDs the user reviewed in the project conversation.
    for pid in ("4145521", "3590451", "4148979", "3821619", "4157731", "3922916", "4139351"):
        exclusions[pid].add("user_review_in_project_conversation")
    for path in Path("generated-artifacts/instagram-user-reviews").glob("*.json"):
        value = json.loads(path.read_text())
        if value.get("profileId"):
            exclusions[str(value["profileId"])].add(str(path))
    for path in Path("generated-artifacts/instagram-likely-export-after-continuation").glob("correction-audit*.json"):
        for row in json.loads(path.read_text()).get("excluded", []):
            exclusions[str(row["profile_id"])].add(str(path))
    for path in Path("generated-artifacts").glob("*/*.csv"):
        description = str(path).casefold()
        if "instagram" not in description or not re.search(r"(?:sample|random)", description):
            continue
        if path.stat().st_size > 15000000:
            raise ValueError("Previously sampled CSV unexpectedly large: " + str(path))
        with path.open(encoding="utf-8-sig", newline="") as stream:
            for row in csv.DictReader(stream):
                pid = row.get("profile_id") or row.get("profileId")
                if pid and re.fullmatch(r"\d+", pid):
                    exclusions[pid].add("prior_sample_conservatively_excluded:" + str(path))
    return {pid: sorted(sources) for pid, sources in exclusions.items()}


def build(work):
    deny_network()
    manifest = json.loads((work / "manifest.json").read_text())
    assert manifest["status"] == "stored_catalog_frozen"
    # Catalog facts can be frozen while the offline draft is being tested.
    # Seal the final rule code here, before scoring or any table creation.
    manifest["draft_rules_sha256"] = manifest["rules_sha256"]
    manifest["rules_sha256"] = sha(RULES)
    manifest["rules_frozen_at"] = datetime.now(timezone.utc).isoformat()
    packets = {name: json.loads((work / (name + ".json")).read_text())
               for name in manifest["context_hashes"]}
    assert all(sha(work / (name + ".json")) == digest for name, digest in manifest["context_hashes"].items())
    bindings = defaultdict(list)
    for value in packets["profiles"]["rows"]:
        bindings[value["profile_id"]].append(value)
    genres = {value["cm_artist"]: value["tags"] for value in packets["genres"]["rows"]}
    tracks = {value["cm_artist"]: value["tracks"] for value in packets["tracks"]["rows"]}
    rows = source_rows()
    output, reasons, decisions, gaps, checks = [], Counter(), Counter(), Counter(), defaultdict(Counter)
    excluded = reviewed_profiles()
    for row in rows:
        bound = bindings.get(row["profile_id"], [])
        valid_binding = len(bound) == 1 and bound[0]["cm_artist"] == row["cm_artist"]
        genre_entries = genres.get(row["cm_artist"], []) if valid_binding else []
        track_entries = tracks.get(row["cm_artist"], []) if valid_binding else []
        context = {"catalog_binding": "matched" if valid_binding else "unavailable_or_changed",
                   "profile": bound, "genres": sorted({entry[0] for entry in genre_entries}),
                   "genre_records": genre_entries, "track_titles": sorted({entry[1] for entry in track_entries}),
                   "track_records": track_entries, "track_catalog_complete": False,
                   "source": "frozen_read_only_stored_catalog_snapshot",
                   "catalog_observed_at": {name: packet["observed_at"] for name, packet in packets.items()},
                   "context_hashes": manifest["context_hashes"]}
        result = recheck(row, context)
        record = {key: row[key] for key in ("profile_id", "cm_artist", "artist_name", "tier",
                                          "selected_url", "selected_handle", "source_batch_id")}
        record.update(display_name=row["scrapecreators_full_name"] or "", source_rules_version=row["rules_version"],
                      rules_version=RULES_VERSION, run_id=manifest["run_id"],
                      decision=result["decision"], reason_codes_json=text(result["reason_codes"]),
                      qualifying_match_codes_json=text(result["qualifying_match_codes"]),
                      check_statuses_json=text(result["check_statuses"]), data_gaps_json=text(result["data_gaps"]),
                      normalized_artist_name=result["normalized_artist_name"],
                      normalized_display_name=result["normalized_display_name"],
                      normalized_handle_name=result["normalized_handle_name"],
                      rule_evidence_json=text(result["evidence"]), catalog_context_json=text(context),
                      source_row_sha256=hashlib.sha256(text(row).encode()).hexdigest(),
                      rules_sha256=manifest["rules_sha256"])
        output.append(record)
        decisions[result["decision"]] += 1
        if result["decision"] == "review":
            reasons.update(result["reason_codes"])
        gaps.update(result["data_gaps"])
        for name, value in result["check_statuses"].items():
            checks[name][value] += 1
    assert len(output) == len({r["profile_id"] for r in output}) == 48333
    pq.write_table(pa.Table.from_pylist(output, schema=SCHEMA), work / "recheck.parquet",
                   compression="zstd", row_group_size=2000)
    keep = sorted((r for r in output if r["decision"] == "keep" and r["profile_id"] not in excluded),
                  key=lambda r: (int(r["profile_id"]), r["selected_url"]))
    assert len(keep) >= 40, "Insufficient eligible keep rows for the requested independent sample"
    sample = random.Random(SEED).sample(keep, 40)
    fields = ["profile_id", "cm_artist", "artist_name", "tier", "selected_url", "display_name",
              "reason_kept", "reason_codes", "rules_version", "run_id"]
    with (work / "keep-sample-40.csv").open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for row in sample:
            codes = json.loads(row["reason_codes_json"])
            value = {k: row[k] for k in fields if k in row}
            value.update(reason_kept="; ".join(REASON_DESCRIPTIONS[c] for c in codes), reason_codes=";".join(codes))
            writer.writerow({k: ("'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@")) else v)
                             for k, v in value.items()})
    save(work / "previously-reviewed-exclusions.json",
         {"scope": "Known project feedback plus prior exported IG random samples, not unknown external reviews.",
          "profiles": excluded, "seed": SEED, "eligible_keep_rows": len(keep),
          "sample_profile_ids": [r["profile_id"] for r in sample]})
    save(work / "summary.json", {"rows": len(output), "decisions": dict(decisions),
                                "review_reason_counts_nonexclusive": dict(reasons.most_common()),
                                "data_gap_counts": dict(gaps), "check_status_counts": dict(checks),
                                "sample_seed": SEED, "sample_rows": len(sample),
                                "sample_eligible_keep_rows": len(keep),
                                "excluded_known_profile_ids": len(excluded),
                                "provider_calls": 0, "model_calls": 0, "accuracy_measured": False})
    shutil.copy2(RULES, work / RULES.name)
    shutil.copy2(Path(__file__), work / Path(__file__).name)
    manifest.update(status="scored_offline", recheck_sha256=sha(work / "recheck.parquet"),
                    row_count=len(output))
    save(work / "manifest.json", manifest)
    print((work / "summary.json").read_text(), flush=True)


REASON_DESCRIPTIONS = {
    "EXACT_CATALOG_SPOTIFY_LINK": "Saved Instagram links contain the exact catalog Spotify artist ID",
    "EXACT_CATALOG_YOUTUBE_CHANNEL": "Saved Instagram links contain the exact catalog YouTube channel",
    "EXACT_CATALOG_SOCIAL_HANDLE": "Instagram handle exactly matches a catalog Twitter, TikTok or YouTube handle",
    "EXACT_NORMALIZED_DISPLAY_NAME": "Instagram display name exactly matches the normalized artist name",
    "EXACT_NORMALIZED_HANDLE_WITH_DISPLAY_NAME": "Normalized handle matches the artist and the full name appears in the display name",
}


def publish(work):
    manifest = json.loads((work / "manifest.json").read_text())
    assert manifest["status"] == "scored_offline", "Do not replay a started publication"
    assert sha(work / "recheck.parquet") == manifest["recheck_sha256"]
    assert sha(RULES) == manifest["rules_sha256"]
    assert pq.read_metadata(work / "recheck.parquet").num_rows == manifest["row_count"] == 48333
    client = Client()
    assert not existing_target(client), "Target already exists; no overwrites or alternate destinations"
    columns = ",".join("`" + name + "` " + kind for name, kind in CH_SCHEMA)
    ddl = f"CREATE TABLE {TABLE} ({columns}) ENGINE=MergeTree ORDER BY profile_id"
    client.execute(ddl)
    manifest.update(status="created_loading", acknowledged_rows=0, create_table_sql=ddl)
    save(work / "manifest.json", manifest)
    for ordinal, batch in enumerate(pq.ParquetFile(work / "recheck.parquet").iter_batches(batch_size=2000)):
        payload = io.BytesIO()
        pq.write_table(pa.Table.from_batches([batch]), payload, compression="zstd")
        client.execute(f"INSERT INTO {TABLE} FORMAT Parquet", payload.getvalue(),
                       query_id=manifest["run_id"] + "-recheck-" + str(ordinal))
        manifest["acknowledged_rows"] += batch.num_rows
        save(work / "manifest.json", manifest)
    manifest["status"] = "acknowledged_awaiting_verification"
    save(work / "manifest.json", manifest)
    print(text({"acknowledged_rows": manifest["acknowledged_rows"]}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["collect", "build", "publish"])
    parser.add_argument("--workdir", type=Path, required=True)
    args = parser.parse_args()
    {"collect": collect, "build": build, "publish": publish}[args.action](args.workdir)


if __name__ == "__main__":
    main()
