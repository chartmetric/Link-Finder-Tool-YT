"""Offline, additive UI archive builder. Reads frozen files only; no network.

Usage: python scripts/import_saved_verification_results.py [--root generated-artifacts]
       [--output generated-artifacts/saved-verification-ui]
Publish the output with artifacts/api-server/scripts/publish-artist-archives.ts.
Missing inputs fail explicitly. Fixtures exercise this importer in isolated checkouts.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path


def text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def field(label, value, group="raw"):
    return dict(label=label, value=text(value), group=group)


def read_json(file):
    return json.loads(file.read_text(encoding="utf-8"))


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def column_group(label):
    if label in ("artist", "profileId", "instagramUrl", "role", "kind"):
        return "identity"
    if "metadata" in label.lower() or "Supplied" in label or label == "completeRequestJson":
        return "metadata"
    if any(s in label.lower() for s in ("sha256", "source", "model", "cost")):
        return "provenance"
    return "decision"


def key(row):
    return (str(row["profileId"]), row.get("role", row.get("kind", "candidate")),
            row.get("instagramUrl", row.get("url", row.get("accountUrl", ""))),
            row.get("rubric", row.get("variant", "")))


def row_status(row, control):
    if control:
        return "control"
    status = row.get("status", "")
    if row.get("sharedAcrossArtists"):
        return "shared_handle"
    if status == "no_saved_candidate":
        return "no_candidate"
    if status == "held_without_call":
        return "held"
    if status in ("failed", "unresolved", "error", "partial_failure"):
        return "partial_failure"
    if status in ("skipped", "not_dispatched", "prepared"):
        return "skipped"
    if row.get("researchPolicySupport") is True or row.get("supportedForResearchOnly") is True:
        return "research_supported"
    return "review"


def build_document(directory, scope_file, batch_id, title, created_at, source_rows_file=None):
    """Do not infer completed checks from preparation; join only retained results."""
    scope, summary = read_json(scope_file), read_json(directory / "summary.json")
    results = [json.loads(line) for line in (directory / "results.jsonl").read_text().split("\n") if line.strip()]
    csv_file = directory / "artist-instagram-findings.csv"
    csv_rows = list(csv.DictReader(io.StringIO(csv_file.read_text(encoding="utf-8-sig"))))
    csv_by_key = {}
    for row in csv_rows:
        k = key(row)
        if k in csv_by_key:
            raise ValueError("Duplicate CSV comparison identity.")
        csv_by_key[k] = row
    requests = scope.get("requests", [])
    request_by_hash = {r["sha256"]: r for r in requests}
    sources = read_json(source_rows_file) if source_rows_file else []
    source_by_key = {r["key"]: r for r in sources if r.get("key")}
    outcomes_file = directory / "artist-outcomes.json"
    outcomes = read_json(outcomes_file) if outcomes_file.exists() else []
    outcome_by_id = {str(o["profileId"]): o for o in outcomes}
    artist_by_id = {str(a["profile_id"]): a for a in scope.get("artists", [])}
    files = [scope_file, directory / "summary.json", directory / "results.jsonl", csv_file]
    files += [f for f in [source_rows_file, outcomes_file] if f and f.exists()]
    rows = []

    def append(record, columns=None, request=None, source=None):
        control = record.get("role", record.get("kind")) == "control"
        status = row_status(record, control)
        pid = str(record["profileId"])
        url = record.get("instagramUrl", record.get("url")) or None
        fields = [field(k, v, column_group(k)) for k, v in (columns or {}).items()]
        # Original CSV labels and values are never renamed or discarded.
        fields.extend([
            field("Research result status", status, "decision"),
            field("Live verified link", "", "identity"),
            field("Live-link interpretation", "Research suggestions only. No live links written.", "decision"),
            field("Retained result (JSON)", record),
        ])
        if source:
            fields.append(field("Saved source evidence available, not necessarily sent (JSON)", source, "metadata"))
        if pid in artist_by_id:
            fields.append(field("Catalog artist available, not necessarily sent (JSON)", artist_by_id[pid], "metadata"))
        if request:
            if request["sha256"] != record.get("requestSha256"):
                raise ValueError("Request receipt mismatch.")
            if "body" in request:
                body = request["body"]
                if hashlib.sha256(text(body).encode()).hexdigest() != request["sha256"]:
                    raise ValueError("Frozen request body does not match receipt.")
            else:
                file = (scope_file.parent / request["requestFile"]).resolve()
                if scope_file.parent.resolve() not in file.parents:
                    raise ValueError("Request path escapes the frozen scope.")
                if digest(file) != request["sha256"]:
                    raise ValueError("Archived request bytes do not match receipt.")
                body = read_json(file)
            if record.get("metadataActuallyUsed") is not None and body.get("state") != record["metadataActuallyUsed"]:
                raise ValueError("Supplied metadata differs from the archived request.")
            fields.extend([
                field("Complete archived request actually sent (JSON)", body, "metadata"),
                field("Archived request SHA256", request["sha256"], "provenance"),
                field("Prepared request provenance (JSON)", {k: v for k, v in request.items() if k != "body"}, "provenance"),
            ])
        elif record.get("requestSha256"):
            raise ValueError("Result has no matching frozen request.")
        else:
            fields.append(field("Metadata delivery status", "No retained request; no completed model check is claimed.", "provenance"))
        if pid in outcome_by_id:
            fields.append(field("Artist outcome (JSON)", outcome_by_id[pid], "decision"))
        fields.append(field("Source archive", str(directory), "provenance"))
        rows.append(dict(id=f"{batch_id}:{len(rows)}", artistName=record.get("artist", ""), profileId=pid,
                         candidateUrl=url, verifiedUrl=None, status=status,
                         score=record.get("score"), verdict=record.get("verdict"),
                         comparisonType="control" if control else record.get("rubric"), fields=fields))

    seen_keys = set()
    seen_requests = set()
    for result in results:
        k = key(result)
        if k in seen_keys or k not in csv_by_key:
            raise ValueError("Result/CSV comparison identity mismatch.")
        seen_keys.add(k)
        if result.get("requestSha256"):
            seen_requests.add(result["requestSha256"])
        append(result, csv_by_key.pop(k), request_by_hash.get(result.get("requestSha256")),
               source_by_key.get(result.get("key")))
    # Include held/no-candidate rows, plus planned work without a retained response.
    for source in sources:
        if source.get("status") != "prepared":
            k = key(source)
            if k not in csv_by_key:
                raise ValueError("Held source row has no matching CSV row.")
            append(source, csv_by_key.pop(k), source=source)
    if csv_by_key:
        raise ValueError("CSV contains rows not represented in results or held source rows.")
    for request in requests:
        if request["sha256"] not in seen_requests:
            append(dict(profileId=request["profileId"], artist=request["artist"],
                        role=request.get("role", request.get("kind")),
                        instagramUrl=request.get("instagramUrl", request.get("accountUrl")),
                        rubric=request.get("variant"), status="not_dispatched",
                        reason="No retained response; dispatch outcome unknown. No automatic retry authorized."))
    represented = {r["profileId"] for r in rows if r["comparisonType"] != "control"}
    for artist in scope.get("artists", []):
        if str(artist["profile_id"]) not in represented:
            append(dict(profileId=str(artist["profile_id"]), artist=artist["artist"], status="skipped",
                        reason="No retained candidate outcome. Not evidence of an absent account."))
    targets = [r for r in rows if r["comparisonType"] != "control"]
    target_results = [r for r in results if r.get("role", r.get("kind")) != "control"]
    controls = [r for r in results if r.get("role", r.get("kind")) == "control"]
    budget = summary.get("budget", {})
    shared = summary.get("sharedBudget", {})
    reserved_cents = budget.get("reservedCents", summary.get("reservedCents"))
    limit_cents = budget.get("maximumSpendCents", summary.get("maximumReservedCents"))
    budget_id = budget.get("budgetId", shared.get("budgetId", scope.get("authorization", {}).get("budgetId")))
    metric = lambda label, value: dict(label=label, value=text(value))
    metrics = [
        metric("Artists with usable evidence / evaluated", len({str(r["profileId"]) for r in target_results if r.get("score") is not None})),
        metric("Research-supported artists", len({r["profileId"] for r in targets if r["status"] == "research_supported"})),
        metric("Held rows (no call)", sum(r["status"] == "held" for r in targets)),
        metric("Skipped / no retained response rows", sum(r["status"] == "skipped" for r in targets)),
        metric("Partial failure rows", sum(r["status"] == "partial_failure" for r in targets)),
        metric("Shared-handle holds", sum(r["status"] == "shared_handle" for r in targets)),
        metric("Control comparisons", len(controls)),
        metric("Distinct synthetic control accounts", len({r.get("instagramUrl") for r in controls})),
        metric("Control source artists", summary.get("controlSourceArtists", "Not recorded")),
        metric("Independently reviewed negative labels", summary.get("independentlyReviewedNegativeLabels", 0)),
        metric("Separately approved run limit", f"${limit_cents / 100:.2f}" if limit_cents is not None else "Not recorded"),
        metric("Budget identity", budget_id or "Not recorded"),
    ]
    if shared:
        metrics.extend([metric("Shared pilot ceiling", f"${shared['maxSpendCents'] / 100:.2f}"),
                        metric("Shared pilot cumulative reservation", f"${shared['reservedSpendCents'] / 100:.2f}")])
    if outcomes:
        metrics.append(metric("Artists with incomplete saved evidence", sum(o["status"] == "incomplete_saved_evidence" for o in outcomes)))
    explanation = ("Saved-candidate recheck; research-supported suggestions are NOT live verified links. "
                   "No searches, profile fetches or provider calls are made by this page. "
                   "Controls are synthetic comparisons, not independently reviewed negative labels or calibrated accuracy. "
                   "Provider-reported cost is distinct from conservative reservations and approved spending limits. "
                   "Absent or held evidence does not prove an absent account. Historical decisions remain unchanged.")
    batch = dict(id=batch_id, title=title, createdAt=created_at, status=summary["status"], source="diagnostic",
                 artistCount=len({r["profileId"] for r in targets}),
                 candidateCount=len({(r["profileId"], r["candidateUrl"]) for r in targets if r["candidateUrl"]}),
                 rowCount=len(rows), verifiedCount=0, reviewCount=sum(r["status"] == "review" for r in targets),
                 notInspectedCount=sum(r["status"] in ("held", "skipped") for r in targets),
                 metadataFailedCount=0, noCandidateCount=sum(r["status"] == "no_candidate" for r in targets),
                 reservedUsd=reserved_cents / 100 if reserved_cents is not None else None,
                 reportedUsd=summary.get("providerReportedCostUsd"), explanation=explanation, metrics=metrics,
                 details=[field("Original execution summary (JSON)", summary, "decision"),
                          field("Original scope metadata (JSON)", {k: v for k, v in scope.items() if k not in ("artists", "requests")}, "provenance"),
                          field("Imported file provenance and SHA256 (JSON)", [dict(file=str(f), sha256=digest(f)) for f in files], "provenance")])
    return dict(batch=batch, rows=rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("generated-artifacts"))
    parser.add_argument("--output", type=Path, default=Path("generated-artifacts/saved-verification-ui"))
    args = parser.parse_args()
    bulk = args.root / "saved-bulk-approved-500-usd20"
    paired = args.root / "verification-test-preparation"
    approval_file = bulk / "execution-paid/approval.json"
    approval = read_json(approval_file)
    paired_summary = read_json(paired / "approved-execution/summary.json")
    # Stable archive identifiers and dates identify these completed runs, not imports.
    docs = [
        build_document(bulk / "execution-paid", bulk / "scope.json", "saved-candidate-recheck-500",
                       "Saved-candidate recheck · 500 artists · $20 approval", approval["at"], bulk / "source-rows.json"),
        build_document(paired / "approved-execution", paired / "paired-scope/prepared-manifest.json",
                       "saved-candidate-paired-comparison", "Saved-candidate paired comparison · baseline / proposed",
                       paired_summary["sharedBudget"]["observedAt"]),
    ]
    docs[0]["batch"]["details"].append(field("Execution approval receipt (JSON)", approval, "provenance"))
    args.output.mkdir(parents=True, exist_ok=True)
    for doc in docs:
        encoded = text(doc)
        if len(encoded.encode()) > 40 * 1024 * 1024:
            raise ValueError("Import exceeds bounded archive size.")
        (args.output / f"{doc['batch']['id']}.json").write_text(encoded)
        print(doc["batch"]["id"], doc["batch"]["artistCount"], "artists", len(doc["rows"]), "rows")
    (args.output / "index.json").write_text(text(dict(batches=[d["batch"] for d in docs], warnings=[])))


if __name__ == "__main__":
    main()
