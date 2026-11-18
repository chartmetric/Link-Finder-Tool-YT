"""Reconcile every exported field and report the two new ClickHouse tables."""

import csv
import hashlib
import json
import struct
from collections import Counter
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from instagram_clickhouse_import import (
    ASSESSED, DATABASE, MANIFEST, SELECTED, SOURCE, STATE, Client, ch_type,
    save_manifest, table_schema,
)

MASK = (1 << 64) - 1


def sql_value(field):
    name = "assumeNotNull(`" + field.name + "`)"
    if pa.types.is_boolean(field.type):
        return "toString(toUInt8(" + name + "))"
    if pa.types.is_int64(field.type) or pa.types.is_float64(field.type):
        return "hex(reinterpretAsFixedString(" + name + "))"
    assert pa.types.is_string(field.type)
    return name


def sql_frame(schema):
    parts = []
    for field in schema:
        value = sql_value(field)
        parts.append("if(isNull(`" + field.name + "`),'N;',concat('V',toString(length("
                     + value + ")),':'," + value + ",';'))")
    return "concat(" + ",".join(parts) + ")"


def python_frame(row, schema):
    output = []
    for field in schema:
        value = row[field.name]
        if value is None:
            output.append(b"N;")
            continue
        if pa.types.is_boolean(field.type):
            raw = b"1" if value else b"0"
        elif pa.types.is_int64(field.type):
            raw = struct.pack("<q", value).hex().upper().encode()
        elif pa.types.is_float64(field.type):
            raw = struct.pack("<d", value).hex().upper().encode()
        else:
            raw = value.encode()
        output.append(b"V" + str(len(raw)).encode() + b":" + raw + b";")
    return b"".join(output)


def source_fingerprint(path):
    parquet = pq.ParquetFile(path)
    xor_value, sum_value, count = 0, 0, 0
    for batch in parquet.iter_batches(batch_size=500):
        for row in batch.to_pylist():
            digest = hashlib.md5(python_frame(row, parquet.schema_arrow)).digest()
            xor_value ^= int.from_bytes(digest[:8], "little")
            sum_value = (sum_value + int.from_bytes(digest[8:], "little")) & MASK
            count += 1
    return {"rows": count, "row_hash_xor": xor_value, "row_hash_sum": sum_value}


def verify_table(client, table, path, manifest):
    fields = pq.read_schema(path)
    expected = source_fingerprint(path)
    frame = sql_frame(fields)
    digest = "MD5(" + frame + ")"
    actual = client.select(
        "SELECT count() AS rows,uniqExact(profile_id) AS distinct_profile_ids,"
        "uniqExact(export_run_id) AS run_ids,"
        "groupBitXor(reinterpretAsUInt64(substring(" + digest + ",1,8))) AS row_hash_xor,"
        "sumWithOverflow(reinterpretAsUInt64(substring(" + digest + ",9,8))) AS row_hash_sum,"
        "min(toString(exported_at)) AS exported_at_min,max(toString(exported_at)) AS exported_at_max "
        f"FROM `{DATABASE}`.`{table}`")[0]
    for key, value in expected.items():
        assert int(actual[key]) == value, ("whole-row reconciliation mismatch", table, key, actual[key], value)
    assert int(actual["run_ids"]) == 1
    assert actual["exported_at_min"] == actual["exported_at_max"] == manifest["exported_at"].replace("T", " ").split("+")[0]
    run_count = client.select(f"SELECT count() AS rows FROM `{DATABASE}`.`{table}` "
                              f"WHERE export_run_id='{manifest['export_run_id']}'")[0]
    assert int(run_count["rows"]) == expected["rows"]
    columns = client.select(
        "SELECT name,type FROM system.columns WHERE database='poc_new_verticals' "
        f"AND table='{table}' ORDER BY position")
    assert [(r["name"], r["type"]) for r in columns] == [
        (f.name, ch_type(f)) for f in table_schema(table == ASSESSED)]
    capture = client.select(
        "SELECT if(capture_evidence_source='none','no capture found',capture_status) AS status,"
        "count() AS rows "
        f"FROM `{DATABASE}`.`{table}` GROUP BY status ORDER BY status")
    no_verdict = client.select(
        f"SELECT countIf(isNull(jev_verdict) OR jev_verdict='') AS no_model_verdict,"
        "countIf(capture_provider_error_flag=true) AS provider_warning_rows,"
        "countIf(original_model_state_available=false) AS no_recorded_model_state "
        f"FROM `{DATABASE}`.`{table}`")[0]
    rules = client.select(
        "SELECT source_batch_id,rules_version,rules_fingerprint_sha256,count() AS rows "
        f"FROM `{DATABASE}`.`{table}` "
        "GROUP BY source_batch_id,rules_version,rules_fingerprint_sha256 "
        "ORDER BY source_batch_id,rules_version,rules_fingerprint_sha256")
    null_sql = ",".join("countIf(isNull(`" + f.name + "`)) AS `" + f.name + "`" for f in fields)
    nulls = client.select(f"SELECT {null_sql} FROM `{DATABASE}`.`{table}`")[0]
    report = {
        "table": DATABASE + "." + table,
        "rows": int(actual["rows"]), "distinct_profile_ids": int(actual["distinct_profile_ids"]),
        "all_exported_fields_match_source": True,
        "row_hash_xor": expected["row_hash_xor"], "row_hash_sum": expected["row_hash_sum"],
        "exported_at": actual["exported_at_min"],
        "capture_status_counts": {status: next((int(r["rows"]) for r in capture if r["status"] == status), 0)
                                  for status in ("ok", "empty", "failed", "no capture found")},
        **{k: int(v) for k, v in no_verdict.items()}, "rules_by_batch": rules,
        "null_counts": {k: int(v) for k, v in nulls.items() if int(v)},
    }
    if table == SELECTED:
        assert report["rows"] == report["distinct_profile_ids"] == 48333
    return report


def main():
    manifest = json.loads(MANIFEST.read_text())
    client = Client()
    selected_cache = STATE / "selected-table-verified.json"
    if selected_cache.exists():
        cached = json.loads(selected_cache.read_text())
        assert cached["source_sha256"] == hashlib.sha256(SOURCE.read_bytes()).hexdigest()
        current = client.select(
            "SELECT count() AS rows,uniqExact(profile_id) AS profiles,"
            "groupUniqArray(export_run_id) AS runs FROM poc_new_verticals.musician_instagram_selected")[0]
        assert int(current["rows"]) == int(current["profiles"]) == 48333
        assert current["runs"] == [manifest["export_run_id"]]
        selected_report = cached["report"]
    else:
        selected_report = verify_table(client, SELECTED, SOURCE, manifest)
    reports = [
        selected_report,
        verify_table(client, ASSESSED, STATE / "instagram-candidates-assessed.parquet", manifest),
    ]
    # Audit an old export field without altering the requested exact publication.
    nested_statuses = Counter()
    nested_rows = 0
    for batch in pq.ParquetFile(SOURCE).iter_batches(columns=["other_checked_candidates_json"], batch_size=1000):
        for cell in batch.column(0).to_pylist():
            for candidate in json.loads(cell):
                nested_statuses[candidate.get("status") or "not_recorded"] += 1
                nested_rows += 1
    unchecked = sum(nested_statuses.get(status, 0) for status in ("uninspected", "not_checked", "not_inspected"))
    assessed_selected_cohort = client.select(
        "SELECT countIf(selected_url IS NOT NULL) AS selected_cohort_alternatives,"
        "countIf(candidate_handle=selected_handle AND selected_url IS NOT NULL) AS erroneously_selected_pairs,"
        "countIf(policy_decision_status IN ('uninspected','not_checked','not_inspected')) AS uninspected_rows "
        "FROM poc_new_verticals.musician_instagram_candidates_assessed")[0]
    assert int(assessed_selected_cohort["selected_cohort_alternatives"]) == nested_rows - unchecked
    assert int(assessed_selected_cohort["erroneously_selected_pairs"]) == 0
    assert int(assessed_selected_cohort["uninspected_rows"]) == 0
    capture_receipt_quality = client.select(" UNION ALL ".join(
        f"SELECT '{table}' AS table,countIf(raw_capture_receipt_available=false) AS no_raw_receipt,"
        "countIf(startsWith(capture_evidence_source,'normalized_')) AS normalized_evidence_only "
        f"FROM `{DATABASE}`.`{table}`" for table in (SELECTED, ASSESSED)))
    report = {
        "export_run_id": manifest["export_run_id"], "exported_at": manifest["exported_at"],
        "tables": reports, "existing_tables_overwritten": False,
        "new_provider_calls": 0,
        "capture_receipt_quality": capture_receipt_quality,
        "assessed_scope": json.loads((STATE / "assessed-export-summary.json").read_text())["scope"],
        "selected_nested_other_candidates_audit": {
            "total_entries": nested_rows, "statuses": dict(nested_statuses),
            "actual_assessed_alternatives": nested_rows - unchecked,
            "explicitly_uninspected_search_hits": unchecked,
            "new_assessed_table_selected_cohort_rows": int(assessed_selected_cohort["selected_cohort_alternatives"]),
            "note": "The original selected file is unchanged. Its legacy nested other-candidate field includes "
                    "explicitly uninspected hits; those are not treated as assessments in the new assessed table.",
        },
    }
    (STATE / "clickhouse-publication-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    with (STATE / "rules-by-batch.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=["table", "source_batch_id", "rules_version", "rules_fingerprint_sha256", "rows"])
        writer.writeheader()
        for table in reports:
            writer.writerows({"table": table["table"], **row} for row in table["rules_by_batch"])
    with (STATE / "blank-column-counts.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["table", "column", "null_rows", "total_rows"])
        for table in reports:
            writer.writerows([table["table"], name, count, table["rows"]]
                            for name, count in table["null_counts"].items())
    manifest["status"] = "both_tables_loaded_and_all_fields_verified"
    manifest["verified_counts"] = {r["table"].split(".")[-1]: {
        "rows": r["rows"], "distinct_profile_ids": r["distinct_profile_ids"]} for r in reports}
    save_manifest(manifest)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
