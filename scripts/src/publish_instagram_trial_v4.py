"""Create-only results/evidence publication. Never touch a historical table."""
import hashlib
import json
import re
import sys
import time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from instagram_clickhouse_import import Client
from instagram_trial_transport import file_sha, save_new, utc
from prepare_instagram_trial_v4 import ROOT
from report_instagram_trial_v4 import frozen_rows
from rescore_instagram_trial_v4 import OLD

DATABASE = "poc_new_verticals"
PUBLISH = ROOT.parent / "publication"


def json_text(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def write_parquet(path, rows, fields):
    schema = pa.schema([pa.field(name, pa.string()) for name in fields])
    expected = {}
    with pq.ParquetWriter(path, schema, compression="zstd") as writer:
        chunk = []
        for row, key, content in rows:
            if key in expected:
                raise ValueError("Duplicate publication identity")
            expected[key] = hashlib.sha256(content.encode()).hexdigest()
            chunk.append(row)
            if len(chunk) >= 100:
                writer.write_table(pa.Table.from_pylist(chunk, schema=schema))
                chunk = []
        if chunk:
            writer.write_table(pa.Table.from_pylist(chunk, schema=schema))
    return expected


def verify_readback(client, name, expected, id_column, content_column, run):
    # A failed immediate read is not permission to repeat an insert.
    for attempt in range(4):
        if attempt:
            time.sleep(2)
        observed = client.select(
            f"SELECT phase,`{id_column}` AS record_id,lower(hex(SHA256(`{content_column}`))) AS content_sha256 "
            f"FROM `{DATABASE}`.`{name}` WHERE run_id='{run}'")
        actual = {(r["phase"], r["record_id"]): r["content_sha256"] for r in observed}
        if len(actual) == len(observed) and actual == expected:
            save_new(PUBLISH / (name + "-readback-verified.json"), {
                "table": DATABASE + "." + name, "run_id": run, "rows": len(observed),
                "all_content_hashes_verified": True, "read_attempts": attempt + 1, "at": utc()})
            return len(observed)
    raise RuntimeError("STOP: publication read-back differs; do not replay the insert")


def publish():
    frozen, fresh, contexts = frozen_rows()
    report = json.loads((ROOT / "trial-report.json").read_text())
    if report["frozen_decisions_sha256"] != file_sha(ROOT / "decisions-frozen.json"):
        raise ValueError("Trial report differs from frozen results")
    scope = json.loads((ROOT / "scope.json").read_text())
    run = scope["run_id"]
    if not re.fullmatch(r"[0-9a-f-]{36}", run):
        raise ValueError("Invalid new run identity")
    table = "musician_instagram_proof_v4_20261118_" + run.split("-")[0]
    evidence_table = table + "_evidence"
    replay_path = ROOT.parent / "saved-evidence-rescore" / "rescored-all-200-audit.jsonl"
    replay = [json.loads(s) for s in replay_path.read_text().splitlines()]
    old_contexts = {r["profile_id"]: r for r in json.loads((OLD / "inputs.json").read_text())}
    if len(replay) != 200 or len(fresh) != 200:
        raise ValueError("Incorrect replay/fresh row count")
    PUBLISH.mkdir()

    def result_rows():
        for phase, rows, inputs in (("saved_rescore", replay, old_contexts), ("fresh", fresh, contexts)):
            for row in rows:
                context = inputs[row["profile_id"]]
                if context["cm_artist"] != row["cm_artist"]:
                    raise ValueError("Artist/catalog binding differs")
                if row["state"] == "UNFINISHED" and row.get("proof"):
                    raise ValueError("Incomplete artist already has ownership proof")
                if row["state"] == "NOT_FOUND" and (row.get("proof") or row.get("unfinished_checks")):
                    raise ValueError("Negative outcome has proof or unfinished checks")
                audit = json_text({**row, "catalog_context": context, "evaluation_run_id": run})
                record = {
                    "run_id": run, "source_run_id": row["run_id"], "phase": phase,
                    "profile_id": row["profile_id"], "cm_artist": row["cm_artist"],
                    "artist_name": row["artist_name"], "cohort": row["group"],
                    "rules_version": row["rules_version"], "state": row["state"],
                    "instagram_url": row["instagram_url"], "proof_json": json_text(row["proof"]),
                    "audit_json": audit,
                    "trial_gate": "PASSED" if all((
                        report["targets"]["agreement_at_least_95pct"],
                        report["targets"]["wrong_not_found_at_most_5pct"],
                        not report["targets"]["collection_halted"])) else "FAILED",
                    "production_port_authorized": "false", "exported_at": utc()}
                yield record, (phase, row["profile_id"]), audit

    result_fields = ["run_id", "source_run_id", "phase", "profile_id", "cm_artist",
                     "artist_name", "cohort", "rules_version", "state", "instagram_url",
                     "proof_json", "audit_json", "trial_gate", "production_port_authorized", "exported_at"]
    expected_results = write_parquet(PUBLISH / "all-400-results.parquet", result_rows(), result_fields)

    def evidence_rows():
        old_run = json.loads((OLD / "scope.json").read_text())["run_id"]
        for phase, root, source_run in (("saved_rescore", OLD, old_run), ("fresh", ROOT, run)):
            for path in sorted((root / "receipts").glob("*.json")):
                receipt = path.read_text()
                yield {
                    "run_id": run, "source_run_id": source_run, "phase": phase,
                    "receipt_id": path.stem, "receipt_json": receipt,
                    "receipt_sha256": file_sha(path), "exported_at": utc(),
                }, (phase, path.stem), receipt

    evidence_fields = ["run_id", "source_run_id", "phase", "receipt_id",
                       "receipt_json", "receipt_sha256", "exported_at"]
    expected_evidence = write_parquet(PUBLISH / "all-evidence.parquet", evidence_rows(), evidence_fields)
    client = Client()
    status = client.select(
        "SELECT getSetting('readonly') AS readonly_mode,"
        "(SELECT count() FROM system.databases WHERE name='poc_new_verticals') AS db_exists,"
        "(SELECT count() FROM system.tables WHERE database='poc_new_verticals' "
        f"AND name IN ('{table}','{evidence_table}')) AS existing")[0]
    if int(status["readonly_mode"]) or not int(status["db_exists"]) or int(status["existing"]):
        raise RuntimeError("STOP: cannot create both new tables in poc_new_verticals")
    definitions = [
        (table, result_fields, "phase,cohort,profile_id", PUBLISH / "all-400-results.parquet",
         expected_results, "profile_id", "audit_json"),
        (evidence_table, evidence_fields, "phase,receipt_id", PUBLISH / "all-evidence.parquet",
         expected_evidence, "receipt_id", "receipt_json"),
    ]
    published = []
    for name, fields, order, path, expected, id_column, content_column in definitions:
        save_new(PUBLISH / (name + "-create-intent.json"), {"run_id": run, "table": name, "at": utc()})
        columns = ",".join(
            f"`{field}` {'Nullable(String)' if field == 'instagram_url' else 'String'}" for field in fields)
        client.execute(f"CREATE TABLE `{DATABASE}`.`{name}` ({columns}) "
                       f"ENGINE=MergeTree ORDER BY (run_id,{order})", query_id=run + "-create-" + id_column)
        save_new(PUBLISH / (name + "-insert-intent.json"), {
            "run_id": run, "table": name, "rows": len(expected), "parquet_sha256": file_sha(path), "at": utc()})
        client.execute(f"INSERT INTO `{DATABASE}`.`{name}` FORMAT Parquet",
                       payload=path.read_bytes(), query_id=run + "-insert-" + id_column)
        count = verify_readback(client, name, expected, id_column, content_column, run)
        published.append({"table": DATABASE + "." + name, "rows": count,
                          "all_content_hashes_verified": True})
    save_new(PUBLISH / "DATA-LOCATION.json", {
        "run_id": run, "published_at": utc(), "tables": published,
        "results_by_phase": {"saved_rescore": 200, "fresh": 200},
        "existing_tables_modified": False, "full_run_authorized": False})
    print(json_text(published))


def finish_evidence_only():
    """Reconcile the one successful result insert; never execute it again."""
    frozen_rows()
    run = json.loads((ROOT / "scope.json").read_text())["run_id"]
    table = "musician_instagram_proof_v4_20261118_" + run.split("-")[0]
    evidence_table = table + "_evidence"
    result_path = PUBLISH / "all-400-results.parquet"
    intent = json.loads((PUBLISH / (table + "-insert-intent.json")).read_text())
    if intent["parquet_sha256"] != file_sha(result_path) or intent["rows"] != 400:
        raise ValueError("Original publication payload changed")
    client = Client()
    expected = {}
    for batch in pq.ParquetFile(result_path).iter_batches(
            batch_size=100, columns=["phase", "profile_id", "audit_json"]):
        for row in batch.to_pylist():
            expected[(row["phase"], row["profile_id"])] = hashlib.sha256(row["audit_json"].encode()).hexdigest()
    result_count = verify_readback(client, table, expected, "profile_id", "audit_json", run)
    save_new(PUBLISH / "results-readback-recovery.json", {
        "rows": result_count, "all_content_hashes_verified": True, "insert_repeated": False,
        "note": "First immediate verification failed; subsequent exact-key/hash reads matched. Cause unproven.", "at": utc()})
    status = client.select(
        "SELECT getSetting('readonly') AS readonly_mode,"
        "(SELECT count() FROM system.tables WHERE database='poc_new_verticals' "
        f"AND name='{evidence_table}') AS existing")[0]
    if int(status["readonly_mode"]) or int(status["existing"]):
        raise RuntimeError("STOP: evidence destination is unavailable or already exists")
    path = PUBLISH / "all-evidence.parquet"
    expected = {}
    for batch in pq.ParquetFile(path).iter_batches(batch_size=100):
        for row in batch.to_pylist():
            key = (row["phase"], row["receipt_id"])
            if key in expected:
                raise ValueError("Duplicate saved receipt")
            expected[key] = hashlib.sha256(row["receipt_json"].encode()).hexdigest()
    fields = pq.read_schema(path).names
    save_new(PUBLISH / (evidence_table + "-create-intent.json"), {"run_id": run, "table": evidence_table, "at": utc()})
    columns = ",".join(f"`{name}` String" for name in fields)
    client.execute(f"CREATE TABLE `{DATABASE}`.`{evidence_table}` ({columns}) "
                   "ENGINE=MergeTree ORDER BY (run_id,phase,receipt_id)", query_id=run + "-create-receipt_id")
    save_new(PUBLISH / (evidence_table + "-insert-intent.json"), {
        "run_id": run, "table": evidence_table, "rows": len(expected),
        "parquet_sha256": file_sha(path), "at": utc()})
    client.execute(f"INSERT INTO `{DATABASE}`.`{evidence_table}` FORMAT Parquet",
                   payload=path.read_bytes(), query_id=run + "-insert-receipt_id")
    evidence_count = verify_readback(client, evidence_table, expected, "receipt_id", "receipt_json", run)
    published = [
        {"table": DATABASE + "." + table, "rows": result_count, "all_content_hashes_verified": True},
        {"table": DATABASE + "." + evidence_table, "rows": evidence_count, "all_content_hashes_verified": True},
    ]
    save_new(PUBLISH / "DATA-LOCATION.json", {
        "run_id": run, "published_at": utc(), "tables": published,
        "results_by_phase": {"saved_rescore": 200, "fresh": 200},
        "existing_tables_modified": False, "full_run_authorized": False})
    print(json_text(published))


if __name__ == "__main__":
    if sys.argv[1:] == ["--finish-evidence-only"]:
        finish_evidence_only()
    elif sys.argv[1:]:
        raise ValueError("Unknown publication mode")
    else:
        publish()
