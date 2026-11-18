"""Create-only publication to the explicitly authorized PoC database.

One unique table per trial. No IF NOT EXISTS, overwrite, delete, other database
or silent retry. Reconcile any uncertain CREATE/INSERT before another write.
"""
import argparse
import hashlib
import io
import json
import re
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from instagram_clickhouse_import import Client
from instagram_proof_trial import digest
from instagram_trial_transport import file_sha, save_new, utc
from adjudicate_instagram_locked_trial import output_paths
from instagram_trial_complete_evidence import complete_audit_row
from prepare_instagram_locked_trial import ROOT

DATABASE = "poc_new_verticals"


def table_for(scope):
    if not re.fullmatch(r"[0-9a-f-]{36}", scope["run_id"]):
        raise ValueError("Invalid run identity")
    return "musician_instagram_proof_trial_20261117_" + scope["run_id"].split("-")[0]


def create(root):
    scope = json.loads((root / "scope.json").read_text())
    table = table_for(scope)
    client = Client()
    status = client.select(
        "SELECT getSetting('readonly') AS readonly_mode,"
        "(SELECT count() FROM system.databases WHERE name='poc_new_verticals') AS database_exists,"
        "(SELECT count() FROM system.tables WHERE database='poc_new_verticals' "
        f"AND name='{table}') AS table_exists")[0]
    if int(status["readonly_mode"]) or not int(status["database_exists"]) or int(status["table_exists"]):
        raise RuntimeError("STOP: cannot create a new table in the requested database")
    save_new(root / "table-create-intent.json", {
        "run_id": scope["run_id"], "database": DATABASE, "table": table, "at": utc(),
    })
    client.execute(
        f"CREATE TABLE `{DATABASE}`.`{table}` ("
        "run_id String,profile_id String,cm_artist String,artist_name String,"
        "cohort LowCardinality(String),rules_version String,state LowCardinality(String),"
        "instagram_url Nullable(String),decided_at String,proof_json String,audit_json String,"
        "scope_json String,collection_policy_json String,result_sha256 String,"
        "exported_at String) ENGINE=MergeTree ORDER BY (run_id,cohort,profile_id)",
        query_id=scope["run_id"] + "-create")
    save_new(root / "table-created.json", {
        "run_id": scope["run_id"], "database": DATABASE, "table": table,
        "at": utc(), "state": "NEW_TABLE_CREATED_EMPTY",
    })
    print(json.dumps({"table": DATABASE + "." + table, "rows": 0}))


def publish(root):
    scope = json.loads((root / "scope.json").read_text())
    frozen_path, results_path, policy_path = output_paths(root)
    policy = json.loads(policy_path.read_text())
    frozen = json.loads(frozen_path.read_text())
    created = json.loads((root / "table-created.json").read_text())
    table = table_for(scope)
    assert created["run_id"] == scope["run_id"] == frozen["run_id"]
    assert created["table"] == table and created["database"] == DATABASE
    assert len(frozen["hashes"]) == frozen["rows"] == 200
    client = Client()
    assert int(client.select(f"SELECT count() AS n FROM `{DATABASE}`.`{table}`")[0]["n"]) == 0
    input_by_id = {r["profile_id"]: r for r in json.loads((root / "inputs.json").read_text())}
    values = []
    for filename, expected in frozen["hashes"].items():
        path = results_path / filename
        assert re.fullmatch(r"\d+\.json", filename) and file_sha(path) == expected
        r = complete_audit_row(root, filename, json.loads(path.read_text()))
        assert r["run_id"] == scope["run_id"]
        context = input_by_id[r["profile_id"]]
        if context["cm_artist"] != r["cm_artist"]:
            raise ValueError("Result/catalog artist binding differs")
        values.append({
            "run_id": r["run_id"], "profile_id": r["profile_id"], "cm_artist": r["cm_artist"],
            "artist_name": r["artist_name"], "cohort": r["group"],
            "rules_version": r["rules_version"], "state": r["state"],
            "instagram_url": r.get("instagram_url"), "decided_at": r["decided_at"],
            "proof_json": json.dumps(r.get("proof", []), ensure_ascii=False),
            "audit_json": json.dumps({**r, "catalog_context": context}, ensure_ascii=False),
            "scope_json": json.dumps(scope, ensure_ascii=False),
            "collection_policy_json": json.dumps(policy, ensure_ascii=False),
            "result_sha256": expected, "exported_at": utc(),
        })
    assert len({r["profile_id"] for r in values}) == 200
    schema = pa.schema([pa.field(k, pa.string()) for k in values[0]])
    source = pa.Table.from_pylist(values, schema=schema)
    buffer = io.BytesIO()
    pq.write_table(source, buffer, compression="zstd")
    payload = buffer.getvalue()
    save_new(root / "table-insert-intent.json", {
        "run_id": scope["run_id"], "table": DATABASE + "." + table,
        "rows": 200, "at": utc(), "result_set_sha256": digest(values),
    })
    client.execute(f"INSERT INTO `{DATABASE}`.`{table}` FORMAT Parquet",
                   payload=payload, query_id=scope["run_id"] + "-insert-200")
    stored = client.select(
        f"SELECT profile_id,cm_artist,state,result_sha256,lower(hex(SHA256(audit_json))) AS audit_sha256 "
        f"FROM `{DATABASE}`.`{table}` "
        f"WHERE run_id='{scope['run_id']}' ORDER BY profile_id")
    assert sorted((r["profile_id"], r["cm_artist"], r["state"], r["result_sha256"]) for r in stored) == sorted(
        (r["profile_id"], r["cm_artist"], r["state"], r["result_sha256"]) for r in values)
    expected_audits = {r["profile_id"]: hashlib.sha256(r["audit_json"].encode()).hexdigest() for r in values}
    assert all(r["audit_sha256"] == expected_audits[r["profile_id"]] for r in stored)
    save_new(root / "table-publication.json", {
        "run_id": scope["run_id"], "table": DATABASE + "." + table, "at": utc(),
        "rows": len(stored), "distinct_profile_ids": len({r["profile_id"] for r in stored}),
        "verified_result_hashes": True,
    })
    print(json.dumps({"table": DATABASE + "." + table, "rows": len(stored)}))


def publish_evidence(root):
    scope = json.loads((root / "scope.json").read_text())
    frozen_path, _, _ = output_paths(root)
    frozen = json.loads(frozen_path.read_text())
    assert frozen["run_id"] == scope["run_id"] and frozen["rows"] == 200
    table = table_for(scope) + "_evidence"
    client = Client()
    exists = client.select(
        "SELECT count() AS n FROM system.tables WHERE database='poc_new_verticals' "
        f"AND name='{table}'")[0]["n"]
    if int(exists):
        raise RuntimeError("STOP: evidence table already exists; no append or overwrite")
    save_new(root / "evidence-table-create-intent.json", {
        "run_id": scope["run_id"], "table": DATABASE + "." + table, "at": utc()})
    client.execute(
        f"CREATE TABLE `{DATABASE}`.`{table}` (run_id String,evidence_id String,"
        "receipt_sha256 String,receipt_json String,exported_at String) "
        "ENGINE=MergeTree ORDER BY (run_id,evidence_id)",
        query_id=scope["run_id"] + "-create-evidence")
    save_new(root / "evidence-table-created.json", {
        "run_id": scope["run_id"], "table": DATABASE + "." + table, "at": utc()})
    values = []
    for path in sorted((root / "receipts").glob("*.json")):
        if not re.fullmatch(r"[0-9a-f]{64}\.json", path.name):
            raise ValueError("Unexpected receipt filename")
        raw = path.read_text()
        json.loads(raw)  # Invalid evidence must never be silently discarded.
        values.append({"run_id": scope["run_id"], "evidence_id": path.stem,
                       "receipt_sha256": file_sha(path), "receipt_json": raw, "exported_at": utc()})
    assert values and len(values) == len({r["evidence_id"] for r in values})
    payload = io.BytesIO()
    pq.write_table(pa.Table.from_pylist(values), payload, compression="zstd")
    save_new(root / "evidence-table-insert-intent.json", {
        "run_id": scope["run_id"], "table": DATABASE + "." + table, "rows": len(values),
        "at": utc(), "evidence_set_sha256": digest(values)})
    client.execute(f"INSERT INTO `{DATABASE}`.`{table}` FORMAT Parquet",
                   payload=payload.getvalue(), query_id=scope["run_id"] + "-insert-evidence")
    stored = client.select(f"SELECT evidence_id,receipt_sha256,"
                           f"lower(hex(SHA256(receipt_json))) AS stored_sha256 FROM `{DATABASE}`.`{table}` "
                           f"WHERE run_id='{scope['run_id']}' ORDER BY evidence_id")
    assert [(r["evidence_id"], r["receipt_sha256"]) for r in stored] == [
        (r["evidence_id"], r["receipt_sha256"]) for r in values]
    assert all(r["stored_sha256"] == r["receipt_sha256"] for r in stored)
    save_new(root / "evidence-table-publication.json", {
        "run_id": scope["run_id"], "table": DATABASE + "." + table, "rows": len(stored),
        "at": utc(), "verified_evidence_hashes": True})
    print(json.dumps({"table": DATABASE + "." + table, "rows": len(stored)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    command = parser.add_mutually_exclusive_group(required=True)
    command.add_argument("--create", action="store_true")
    command.add_argument("--publish", action="store_true")
    command.add_argument("--publish-evidence", action="store_true")
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    if args.create:
        create(args.root)
    elif args.publish:
        publish(args.root)
    else:
        publish_evidence(args.root)
