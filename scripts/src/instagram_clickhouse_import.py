"""Narrow, non-retrying publisher for the two explicitly requested PoC tables."""

import argparse
import io
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl
from urllib.request import HTTPRedirectHandler, Request, build_opener

import pyarrow as pa
import pyarrow.parquet as pq

DATABASE = "poc_new_verticals"
SELECTED = "musician_instagram_selected"
ASSESSED = "musician_instagram_candidates_assessed"
EXPORT = Path("generated-artifacts/instagram-selected-evidence-2026-11-17")
SOURCE = EXPORT / "instagram-selected-48333-full-evidence.parquet"
STATE = Path("generated-artifacts/instagram-clickhouse-publication")
MANIFEST = STATE / "publication.json"
EXTRA_ASSESSED = [
    pa.field("candidate_url", pa.string()),
    pa.field("candidate_handle", pa.string()),
    pa.field("not_selected_reason", pa.string()),
    pa.field("not_selected_reason_source", pa.string()),
    pa.field("model_verdict_source", pa.string()),
]


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ClickHouseError(RuntimeError):
    pass


class Client:
    def __init__(self):
        host = os.environ["CLICKHOUSE_VERT_HOST"]
        self.base = host if host.startswith(("http://", "https://")) else "https://" + host
        self.headers = {
            "X-ClickHouse-User": os.environ["CLICKHOUSE_USERNAME"],
            "X-ClickHouse-Key": os.environ["CLICKHOUSE_PASSWORD"],
        }
        self.opener = build_opener(NoRedirects())

    def execute(self, query, payload=None, query_id=None):
        # No readonly overrides, role changes, fallback destinations or retries.
        parts = urlsplit(self.base)
        params = dict(parse_qsl(parts.query))
        params.update(database=DATABASE, query_id=query_id or str(uuid.uuid4()),
                      wait_end_of_query="1")
        if payload is not None:
            params.update(query=query, input_format_null_as_default="0")
            body = payload
        else:
            body = query.encode()
        url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(params), ""))
        request = Request(url, data=body, headers=self.headers, method="POST")
        try:
            with self.opener.open(request, timeout=180) as response:
                return response.read()
        except HTTPError as error:
            message = error.read().decode(errors="replace")
            code = re.search(r"Code:\s*(\d+)", message)
            # Never include host, username, credentials, SQL values or raw body.
            raise ClickHouseError(json.dumps({
                "http_status": error.code,
                "clickhouse_code": code.group(1) if code else None,
                "permission_or_readonly_failure": bool(re.search(
                    r"ACCESS_DENIED|READONLY|not enough privileges|read.only", message, re.I)),
            })) from None
        except Exception as error:
            raise ClickHouseError("Uncertain request outcome: " + type(error).__name__) from None

    def select(self, query):
        assert query.lstrip().upper().startswith("SELECT ")
        return json.loads(self.execute(query + " FORMAT JSON"))["data"]


def table_schema(assessed=False):
    base = list(pq.read_schema(SOURCE))
    if assessed:
        base += EXTRA_ASSESSED
    return pa.schema(base + [
        pa.field("export_run_id", pa.string(), nullable=False),
        pa.field("exported_at", pa.timestamp("ms", tz="UTC"), nullable=False),
    ])


def ch_type(field):
    if pa.types.is_string(field.type):
        value = "String"
    elif pa.types.is_boolean(field.type):
        value = "Bool"
    elif pa.types.is_int64(field.type):
        value = "Int64"
    elif pa.types.is_float64(field.type):
        value = "Float64"
    elif pa.types.is_timestamp(field.type):
        value = "DateTime64(3, 'UTC')"
    else:
        raise ValueError("Unsupported exported type: " + str(field.type))
    return "Nullable(" + value + ")" if field.nullable else value


def ddl(table, manifest):
    assert table in (SELECTED, ASSESSED)
    columns = []
    for field in table_schema(table == ASSESSED):
        assert re.fullmatch(r"[a-z_][a-z0-9_]*", field.name)
        columns.append("`" + field.name + "` " + ch_type(field))
    return (f"CREATE TABLE `{DATABASE}`.`{table}` (\n" + ",\n".join(columns)
            + "\n) ENGINE = MergeTree ORDER BY tuple() COMMENT "
            + "'Saved Instagram evidence publication; export_run_id=" + manifest["export_run_id"] + "'")


def save_manifest(manifest):
    STATE.mkdir(parents=True, exist_ok=True)
    temp = STATE / "publication.json.tmp"
    temp.write_text(json.dumps(manifest, indent=2))
    temp.replace(MANIFEST)


def prepare():
    client = Client()
    check = client.select(
        "SELECT getSetting('readonly') AS readonly_mode, "
        "(SELECT count() FROM system.databases WHERE name='poc_new_verticals') AS database_exists, "
        "(SELECT groupArray(name) FROM system.tables WHERE database='poc_new_verticals' "
        "AND name IN ('musician_instagram_selected','musician_instagram_candidates_assessed')) AS existing")
    assert len(check) == 1
    if int(check[0]["readonly_mode"]) != 0 or not int(check[0]["database_exists"]):
        raise RuntimeError("STOP: requested database unavailable or session is read-only; no writes performed")
    if check[0]["existing"]:
        raise RuntimeError("STOP: requested table already exists; no overwrite or append performed")
    assert not MANIFEST.exists(), "An earlier publication manifest exists; inspect it before continuing"
    manifest = {
        "export_run_id": str(uuid.uuid4()),
        "exported_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "database": DATABASE,
        "selected_source": str(SOURCE),
        "status": "creating_requested_tables",
        "tables_created": [],
        "inserted_rows_acknowledged": {SELECTED: 0, ASSESSED: 0},
        "automatic_retries": False,
    }
    for table in (SELECTED, ASSESSED):
        try:
            client.execute(ddl(table, manifest), query_id=manifest["export_run_id"] + "-create-" + table)
        except Exception:
            manifest["status"] = "stopped_at_table_creation"
            save_manifest(manifest)
            raise
        manifest["tables_created"].append(table)
        save_manifest(manifest)
    manifest["status"] = "tables_created_empty"
    save_manifest(manifest)
    print(json.dumps({k: manifest[k] for k in ("export_run_id", "exported_at", "status", "tables_created")}))


def publish(table, path):
    assert table in (SELECTED, ASSESSED)
    manifest = json.loads(MANIFEST.read_text())
    assert manifest["tables_created"] == [SELECTED, ASSESSED]
    assert manifest["inserted_rows_acknowledged"][table] == 0
    client = Client()
    info = client.select(
        f"SELECT count() AS rows FROM `{DATABASE}`.`{table}`")[0]
    assert int(info["rows"]) == 0, "Refusing to append to a nonempty table"
    columns = client.select(
        "SELECT name,type FROM system.columns WHERE database='poc_new_verticals' "
        f"AND table='{table}' ORDER BY position")
    expected = table_schema(table == ASSESSED)
    assert [(r["name"], r["type"]) for r in columns] == [(f.name, ch_type(f)) for f in expected]
    published = 0
    for ordinal, batch in enumerate(pq.ParquetFile(path).iter_batches(batch_size=2000)):
        base = pa.Table.from_batches([batch])
        assert base.schema.names == expected.names[:-2], "Source column order changed"
        timestamp = datetime.fromisoformat(manifest["exported_at"])
        base = base.append_column("export_run_id", pa.array([manifest["export_run_id"]] * len(base)))
        base = base.append_column("exported_at", pa.array([timestamp] * len(base), type=expected.field("exported_at").type))
        buffer = io.BytesIO()
        pq.write_table(base, buffer, compression="zstd")
        query_id = manifest["export_run_id"] + "-" + table + "-" + str(ordinal)
        try:
            client.execute(f"INSERT INTO `{DATABASE}`.`{table}` FORMAT Parquet",
                           payload=buffer.getvalue(), query_id=query_id)
        except Exception:
            manifest["status"] = "insert_outcome_requires_reconciliation"
            manifest["uncertain_insert"] = {"table": table, "ordinal": ordinal, "rows": len(base),
                                             "query_id": query_id}
            save_manifest(manifest)
            raise
        published += len(base)
        manifest["inserted_rows_acknowledged"][table] = published
        manifest["status"] = "loading_" + table
        save_manifest(manifest)
    actual = client.select(
        f"SELECT count() AS rows,uniqExact(profile_id) AS distinct_profile_ids "
        f"FROM `{DATABASE}`.`{table}`")[0]
    # A load-balanced read may briefly lag an acknowledged insert. Never
    # interpret that as permission to replay a charged/committed data block.
    if int(actual["rows"]) == published:
        manifest.setdefault("verified_counts", {})[table] = actual
        manifest["status"] = table + "_loaded_and_counted"
    else:
        manifest["status"] = table + "_acknowledged_awaiting_read_reconciliation"
        manifest["observed_counts_pending_reconciliation"] = {table: actual}
    save_manifest(manifest)
    print(json.dumps({"table": DATABASE + "." + table, **actual}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "load-selected", "load-assessed"])
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            prepare()
        elif args.command == "load-selected":
            publish(SELECTED, SOURCE)
        else:
            publish(ASSESSED, STATE / "instagram-candidates-assessed.parquet")
    except Exception as error:
        print(json.dumps({"stopped": True, "error_type": type(error).__name__, "detail": str(error)}))
        raise SystemExit(1)
