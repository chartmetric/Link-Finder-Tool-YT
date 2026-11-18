"""New-table-only publication, single-attempt writes and hash-checked readback."""
import csv
import hashlib
import json
import sys
import time
from collections import Counter

import pyarrow as pa
import pyarrow.parquet as pq

from instagram_clickhouse_import import Client
from instagram_proof_trial import instagram_url
from instagram_trial_transport import file_sha, save_new, utc
from rescore_instagram_trial_v4 import OLD, ROOT as PREVIOUS
from rescore_instagram_trial_v5 import ROOT

DATABASE = "poc_new_verticals"
PUB = ROOT / "publication"
BASE_COLUMNS = ["profile_id", "cm_artist", "artist_name", "locked_instagram_url",
                "found_instagram_url", "proof", "note"]


def text(value):
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def load_rows(path):
    with path.open() as stream:
        return [json.loads(line) for line in stream]


def oracle(source):
    return {str(r["profile_id"]): sorted({instagram_url(u) for u in r["accepted_urls"]})
            for r in json.loads((source / "oracle.evaluator-only.json").read_text())["controls"]}


def save_csv(path, rows, columns):
    with path.open("x", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def disagreement(row, reference, updated):
    found = row["instagram_url"]
    if len(reference) != 1:
        raise ValueError("Disagreement export expects one locked URL")
    target = next((c for c in updated["candidates_checked"] if instagram_url(c["url"]) == instagram_url(found)), {})
    scope = target.get("ownership_scope", {})
    if scope.get("status") == "excluded_multi_artist":
        note = ("Not an alternate/updated artist account: the saved account is a publisher or multi-artist page "
                f"({scope.get('owner_title', '')}). The revised guard withdrew this suggestion.")
    elif updated["state"] != "VERIFIED" or updated["instagram_url"] != found:
        note = ("The original source linked to this account, but its single-artist ownership is not established "
                "by the saved evidence. The revised guard holds this case. Do not assume this is an alternate or renamed account.")
    else:
        note = ("The saved artist-source link differs from the locked reference. This may be an alternate or updated "
                "account, but no rename or account-equivalence history was established. Human confirmation is required.")
    return {"profile_id": str(row["profile_id"]), "cm_artist": str(row["cm_artist"]),
            "artist_name": row["artist_name"], "locked_instagram_url": reference[0],
            "found_instagram_url": found, "proof": text(row["proof"]), "note": note}


def packed_hash(row, fields):
    parts = []
    for key in fields:
        if row[key] is None:
            parts.append(b"N")
        else:
            value = row[key].encode()
            parts += [b"S" + str(len(value)).encode() + b":", value]
    return hashlib.sha256(b"".join(parts)).hexdigest()


def prepare():
    PUB.mkdir()
    run = json.loads((ROOT / "RUN.json").read_text())
    frozen = json.loads((ROOT / "DECISIONS-FROZEN.json").read_text())
    export_at = utc()
    tables, updated = [], {}
    current_differences, comparisons = [], []
    for phase, source in (("first", OLD), ("fresh", PREVIOUS / "fresh-trial")):
        path = ROOT / (phase + "-all-200-audit.jsonl")
        if file_sha(path) != frozen["files"][phase]:
            raise ValueError("Frozen replay changed")
        rows = load_rows(path)
        updated[phase] = {r["profile_id"]: r for r in rows}
        key = oracle(source)
        records = []
        for row in rows:
            reference = key.get(row["profile_id"], [])
            matches = instagram_url(row["instagram_url"]) in reference if row["state"] == "VERIFIED" and reference else None
            records.append({
                "run_id": run["run_id"], "source_trial_run_id": row["source_trial_run_id"],
                "exported_at": export_at, "rules_version": row["rules_version"], "phase": phase,
                "group": row["group"], "profile_id": row["profile_id"], "cm_artist": row["cm_artist"],
                "artist_name": row["artist_name"], "tier": row["tier"],
                "state": row["state"], "instagram_url": row["instagram_url"],
                "before_state": row["before_state"], "before_instagram_url": row["before_instagram_url"],
                "proof_json": row["proof"], "before_proof_json": row["before_proof"],
                "ownership_exclusions_json": row["ownership_exclusions"],
                "locked_instagram_urls_json": reference, "matches_locked_reference": matches,
                "production_port_authorized": False,
                "evaluation_kind": "UNBLINDED_SAVED_REPLAY_NOT_A_NEW_TEST",
                "raw_evidence_table": "poc_new_verticals.musician_instagram_proof_v4_20261118_49325924_evidence",
                "raw_evidence_phase": "saved_rescore" if phase == "first" else "fresh",
                "audit_json": text(row),
            })
            if reference:
                comparisons.append({
                    "trial": phase, "profile_id": row["profile_id"], "artist_name": row["artist_name"],
                    "state": row["state"], "found_instagram_url": row["instagram_url"],
                    "locked_instagram_urls": text(reference), "matches_locked_reference": matches})
                if row["state"] == "VERIFIED" and not matches:
                    current_differences.append({"trial": phase, **disagreement(row, reference, row)})
        name = f"musician_instagram_trial_{phase}_v5_20261118_{run['run_id'][:8]}"
        tables.append((name, records))
    prior = load_rows(PREVIOUS / "fresh-trial" / "fresh-all-200-audit.jsonl")
    key = oracle(PREVIOUS / "fresh-trial")
    original_six = [
        disagreement(r, key[r["profile_id"]], updated["fresh"][r["profile_id"]])
        for r in prior if r["group"] == "backtest" and r["state"] == "VERIFIED"
        and instagram_url(r["instagram_url"]) not in key[r["profile_id"]]]
    if len(original_six) != 6:
        raise ValueError("Original six disagreements changed")
    save_csv(ROOT / "six-original-backtest-disagreements.csv", original_six, BASE_COLUMNS)
    save_csv(ROOT / "all-current-backtest-disagreements.csv", current_differences, ["trial"] + BASE_COLUMNS)
    save_csv(ROOT / "all-200-backtest-comparisons.csv", comparisons, list(comparisons[0]))
    tables.append((
        f"musician_instagram_trial_disagreements_v5_20261118_{run['run_id'][:8]}",
        [{**r, "run_id": run["run_id"], "exported_at": export_at,
          "source_trial_run_id": prior[0]["run_id"], "source_rules_version": prior[0]["rules_version"],
          "current_rules_version": run["rules_version"],
          "current_state": updated["fresh"][r["profile_id"]]["state"],
          "production_port_authorized": False,
          "found_link_snapshot": "ORIGINAL_AS_RUN_V4_NOT_REVISED_APPROVAL"}
         for r in original_six]))
    manifest = {"run_id": run["run_id"], "tables": [], "database": DATABASE,
                "original_disagreements": 6, "current_disagreements_across_both_trials": len(current_differences)}
    for name, records in tables:
        fields = list(records[0])
        nullable = [k for k in fields if k in (
            "instagram_url", "before_instagram_url", "matches_locked_reference")]
        records = [{k: None if k in nullable and r[k] is None else text(r[k])
                    for k in fields} for r in records]
        if len({r["profile_id"] for r in records}) != len(records):
            raise ValueError("Duplicate artist")
        path = PUB / (name + ".parquet")
        pq.write_table(pa.Table.from_pylist(records, schema=pa.schema([
            pa.field(k, pa.string(), nullable=k in nullable) for k in fields])), path, compression="zstd")
        hashes = {r["profile_id"]: packed_hash(r, fields) for r in records}
        save_new(PUB / (name + "-expected-hashes.json"), hashes)
        manifest["tables"].append({"table": name, "rows": len(records), "fields": fields, "nullable": nullable,
                                   "parquet_sha256": file_sha(path)})
    save_new(PUB / "MANIFEST.json", manifest)
    print(text({k: v for k, v in manifest.items() if k != "tables"}))


def verify(client, table):
    name, fields = table["table"], table["fields"]
    pieces = []
    for field in fields:
        value = f"ifNull(`{field}`,'')" if field in table["nullable"] else f"`{field}`"
        expr = f"concat('S',toString(length({value})),':',{value})"
        pieces.append(f"if(isNull(`{field}`),'N',{expr})" if field in table["nullable"] else expr)
    query = (f"SELECT profile_id, lower(hex(SHA256(concat({','.join(pieces)})))) AS row_hash "
             f"FROM `{DATABASE}`.`{name}`")
    expected = json.loads((PUB / (name + "-expected-hashes.json")).read_text())
    for attempt in range(6):
        rows = client.select(query)
        actual = {str(r["profile_id"]): r["row_hash"] for r in rows}
        if len(rows) == len(expected) and actual == expected:
            result = {"table": DATABASE + "." + name, "rows": len(rows),
                      "distinct_profile_ids": len(actual), "all_column_hashes_verified": True}
            save_new(PUB / (name + "-verified.json"), {**result, "at": utc()})
            return result
        if attempt != 5:
            time.sleep(2)
    raise ValueError("STOP: readback mismatch. Do not repeat the insert; reconcile read-only.")


def publish():
    manifest = json.loads((PUB / "MANIFEST.json").read_text())
    client = Client()
    names = ",".join("'" + t["table"] + "'" for t in manifest["tables"])
    preflight = client.select(
        "SELECT getSetting('readonly') AS mode,"
        "(SELECT count() FROM system.databases WHERE name='poc_new_verticals') AS db,"
        f"(SELECT count() FROM system.tables WHERE database='poc_new_verticals' AND name IN ({names})) AS existing")[0]
    if int(preflight["mode"]) or int(preflight["db"]) != 1 or int(preflight["existing"]):
        raise ValueError("STOP: destination absent, read-only, or a destination already exists. No fallback.")
    save_new(PUB / "PREFLIGHT.json", {"at": utc(), "passed": True})
    published = []
    for table in manifest["tables"]:
        name, fields = table["table"], table["fields"]
        path = PUB / (name + ".parquet")
        if file_sha(path) != table["parquet_sha256"]:
            raise ValueError("Parquet changed")
        save_new(PUB / (name + "-create-intent.json"), {"at": utc(), **table})
        client.execute(f"CREATE TABLE `{DATABASE}`.`{name}` (" +
                       ",".join(f"`{f}` " + ("Nullable(String)" if f in table["nullable"] else "String") for f in fields) +
                       ") ENGINE=MergeTree ORDER BY (run_id,profile_id)",
                       query_id=manifest["run_id"] + "-create-" + name)
        save_new(PUB / (name + "-insert-intent.json"), {
            "at": utc(), "rows": table["rows"], "parquet_sha256": table["parquet_sha256"]})
        client.execute(f"INSERT INTO `{DATABASE}`.`{name}` FORMAT Parquet", path.read_bytes(),
                       query_id=manifest["run_id"] + "-insert-" + name)
        save_new(PUB / (name + "-insert-ack.json"), {"at": utc(), "acknowledged": True})
        published.append(verify(client, table))
    save_new(PUB / "DATA-LOCATION.json", {
        "run_id": manifest["run_id"], "tables": published, "published_at": utc(),
        "existing_tables_modified": False, "full_run_authorized": False, "new_paid_calls": 0})
    print(text(published))


if __name__ == "__main__":
    if sys.argv[1:] == ["--prepare"]:
        prepare()
    elif sys.argv[1:] == ["--publish"]:
        publish()
    else:
        raise ValueError("Use --prepare or --publish; writes never retried")
