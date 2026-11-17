"""Export exactly the corrected selected cohort, exclusively from saved files."""

import csv
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from instagram_saved_export_helpers import (
    CAMPAIGN, ROOT, capture_fields, catalog_fields, handle, json_sha, json_text,
    legacy_indexes, other_checked, read_json, resolve_receipts, sha_bytes,
)

SELECTION = Path("generated-artifacts/instagram-likely-export-after-continuation/"
                 "instagram-selected-links-for-unverified-import.csv")
OUTPUT = Path("generated-artifacts/instagram-selected-evidence-2026-11-17")
LIMIT = 100 * 1024 * 1024


def prohibit_network(event, args):
    if event in ("socket.connect", "socket.getaddrinfo", "subprocess.Popen"):
        raise RuntimeError("Offline export: network and child processes are prohibited")


sys.addaudithook(prohibit_network)

BOOL_FIELDS = {
    "scrapecreators_is_business", "raw_capture_receipt_available",
    "normalized_capture_available", "original_model_state_available",
}
INT_FIELDS = {
    "tier", "serper_rank_among_candidates", "serper_organic_position",
    "scrapecreators_followers", "checked_candidate_count", "discovered_candidate_count",
}
FLOAT_FIELDS = {"serper_confidence", "jev_same_identity_probability", "jev_verdict_label_confidence"}
FIELDS = """profile_id cm_artist artist_name tier batch_id source_batch_id rules_version
rules_fingerprint_sha256 selected_url selected_handle serper_title serper_snippet
serper_confidence serper_confidence_source serper_signals_json serper_rank_among_candidates
serper_rank_basis serper_organic_position serper_evidence_json
scrapecreators_full_name scrapecreators_biography scrapecreators_external_urls_json
scrapecreators_bio_link_urls_json scrapecreators_bio_link_page_urls_json
scrapecreators_category scrapecreators_is_business scrapecreators_followers capture_status
capture_status_detail capture_timestamp capture_evidence_source raw_capture_receipt_available
normalized_capture_available link_capture_status jev_verdict jev_rationale_text
jev_rationale_status jev_model jev_requested_model jev_timestamp jev_same_identity_probability
jev_verdict_label_confidence jev_verdict_probabilities_json catalog_country
catalog_spotify_artist_ids_json catalog_youtube_urls_json catalog_tiktok_urls_json
catalog_twitter_urls_json catalog_context_source catalog_accounts_used_json
catalog_artist_context_used_json catalog_reference_url_used other_checked_candidates_json
checked_candidate_count discovered_candidate_count policy_decision_status policy_decision_reason
guard_json verification_rules_used_json evidence_rules_used_json original_request_sha256
original_model_state_available artist_record_source_path artist_record_sha256
capture_receipt_source_path model_receipt_source_path evidence_gaps_json""".split()


def schema():
    fields = []
    for name in FIELDS:
        dtype = (pa.bool_() if name in BOOL_FIELDS else pa.int64() if name in INT_FIELDS
                 else pa.float64() if name in FLOAT_FIELDS else pa.string())
        fields.append(pa.field(name, dtype))
    return pa.schema(fields, metadata={
        b"description": b"48333 selected artist-Instagram pairs; saved evidence only; not catalog acceptance",
        b"collection_fields": b"Columns ending _json contain complete JSON arrays/objects, not delimiter-joined values",
    })


def csv_cell(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return str(value).lower()
    text = str(value)
    return "'" + text if text.startswith(("=", "+", "-", "@", "\t", "\r", "\n")) else text


def serper_position(profile_id, selected):
    """Only direct organic hits qualify; candidate order is a separate column."""
    positions = []
    for index in range(2):
        operation = f"search-{profile_id}-{index}"
        path = ROOT / "receipts" / (json_sha(operation) + ".json")
        if not path.exists():
            continue
        packet = read_json(path)
        assert packet.get("kind") == "search" and packet.get("operationKey") == operation
        for hit in packet.get("data", {}).get("organic", []):
            if handle(hit.get("link") or hit.get("url")) == handle(selected):
                if isinstance(hit.get("position"), int):
                    positions.append(hit["position"])
    return min(positions) if positions else None


def write_readme(summary):
    groups = summary["batch_rules"]
    lines = [
        "# Selected Instagram evidence — saved-data-only export",
        "",
        "## Cohort and safety",
        "Exactly 48,333 unique profile_id/cm_artist pairs from the corrected selected-URL CSV.",
        "This is not Rafael's 42,351-row write subset; no exact manifest for that subset was supplied.",
        "No searches, captures, new model calls, database access or catalog changes were performed.",
        "Existing selections were exported, not re-evaluated. No confidence threshold was applied.",
        "Parquet has one row per artist. Collection fields are JSON strings, preserving every stored item.",
        "IDs are strings to preserve identity exactly. Null means unavailable/not recorded; false and zero remain values.",
        "",
        "## Capture definitions and counts",
        f"- Saved raw ScrapeCreators receipt found: {summary['raw_capture_receipts_found']:,}.",
        f"- No saved raw ScrapeCreators receipt found: {summary['raw_capture_receipts_missing']:,}.",
        f"- No saved capture evidence of any kind: {summary['no_saved_capture_evidence']:,}.",
        f"- No usable saved capture (capture_status is empty or failed): {summary['no_usable_capture']:,}.",
        f"- Status counts: {json_text(summary['capture_status_counts'])}.",
        "ok = usable saved profile; empty = saved successful response with no usable profile object;",
        "failed = recorded failure, or absent capture with an explicit detail. Evidence-source columns distinguish these.",
        "A normalized-only capture remains distinguishable from an original raw receipt.",
        "Blank biography, no websites, or missing provider fields do NOT establish that a visible account lacks them.",
        "scrapecreators_bio_link_urls_json lists the provider's actual bio_links URLs when recoverable.",
        "bio_link_page_urls_json is a convenience subset of captured URLs on recognized link-page hosts,",
        "not a new fetch or an exhaustive classification. All remaining URLs remain in external_urls_json.",
        "",
        "## Models, rationale and historical context",
        "JEV verdict/probability fields are original stored answers, not a new judgment.",
        "When its response contains only typed choices/probabilities, jev_rationale_text is null;",
        "the policy decision reason is in a different column and is NOT presented as model reasoning.",
        "Model and timestamp come from the saved response receipt; requested aliases are separate.",
        "Catalog context comes only from the original saved model request, not current catalog lookups.",
        "The raw capture can contain fields that the model did not receive; capture != original model input.",
        "Full verification/evidence rules and catalog context actually supplied are included as JSON columns.",
        "",
        "## Search confidence, rank and alternatives",
        "Serper provides organic positions, not a calibrated ownership probability.",
        "serper_confidence is the stored discovery candidate's confidence field, if any;",
        "it is NOT filled with the selected CSV's score or JEV probability when absent.",
        "serper_rank_among_candidates is the position in the saved candidate list,",
        "not necessarily Google's organic position. serper_organic_position is populated only from",
        "a saved direct-profile organic hit, and is the minimum across the saved searches when both match.",
        "Other checked candidates are the other findings actually inspected in the saved artist record;",
        "they can include a metadata failure without a model verdict. Unchecked search hits are not relabeled checked.",
        "",
        "## Batch and rules provenance",
        "batch_id is the parent campaign. source_batch_id is the explicit legacy chunk or priority campaign.",
        "The exact parallel executor was not stored on each result and has not been guessed from timestamps.",
        "rules_version is the policy recorded on that candidate; rules_fingerprint_sha256 additionally hashes",
        "the actual recorded verification rules, evidence rules and guard policy (not artist metadata).",
        "The fingerprint is an export provenance aid, not a newly adopted policy version.",
        "The batch/rules CSV gives selected-row counts and missing-capture counts for every observed combination.",
        "The JSON rules manifest preserves each distinct saved rule payload and available frozen runtime hashes.",
        "Approval/runtime metadata describes archived configurations; it does not prove every row used a later config.",
        "No current policy has been retroactively attributed to historical rows.",
        "",
        "| Source batch | Recorded policy | Selected rows | Raw capture missing |",
        "|---|---|---:|---:|",
    ]
    for group in groups:
        lines.append(f"| {group['source_batch_id']} | {group['rules_version']} | {group['selected_rows']} | "
                     f"{group['raw_capture_receipts_missing']} |")
    lines += [
        "",
        "## Missing-field totals",
        "See export-summary.json for per-column null counts, evidence gaps, source selection hash and checks.",
        "The CSV (if included) has UTF-8 BOM and protects formula-leading text with an apostrophe.",
        "Parquet preserves original text without spreadsheet-escaping prefixes.",
    ]
    (OUTPUT / "README.md").write_text("\n".join(lines) + "\n")


def main():
    source_bytes = SELECTION.read_bytes()
    with SELECTION.open(encoding="utf-8-sig", newline="") as stream:
        selection = list(csv.DictReader(stream))
    assert len(selection) == 48333
    assert len({r["profile_id"] for r in selection}) == len(selection)
    baseline = {str(r["profileId"]): r for r in read_json(ROOT / "baseline.json")}
    source_dirs = sorted({r["source"] for r in baseline.values() if r.get("source")})
    indexes = {source: legacy_indexes(source) for source in source_dirs}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    parquet_path = OUTPUT / "instagram-selected-48333-full-evidence.parquet"
    csv_path = OUTPUT / "instagram-selected-48333-full-evidence.csv"
    assert not parquet_path.exists() and not csv_path.exists(), "Use a fresh output directory"
    summary = {
        "created_at": datetime.now(timezone.utc).isoformat(), "cohort": 48333,
        "selection_source": str(SELECTION), "selection_sha256": sha_bytes(source_bytes),
        "paid_calls": 0, "database_reads": 0, "database_writes": 0, "classifications_changed": False,
        "capture_status_counts": Counter(), "capture_source_counts": Counter(),
        "raw_capture_receipts_found": 0, "raw_capture_receipts_missing": 0,
        "no_saved_capture_evidence": 0, "no_usable_capture": 0,
        "model_receipts_missing": 0, "rationale_status_counts": Counter(),
        "null_counts": Counter(), "evidence_gap_counts": Counter(),
    }
    groups = defaultdict(Counter)
    rule_payloads = {}
    pending = []
    with pq.ParquetWriter(parquet_path, schema(), compression="zstd") as writer, \
            csv_path.open("w", encoding="utf-8-sig", newline="") as csv_stream:
        csv_writer = csv.writer(csv_stream)
        csv_writer.writerow(FIELDS)
        for index, selected in enumerate(selection):
            pid, cm = selected["profile_id"], selected["cm_artist"]
            path = ROOT / "artists" / (pid + ".json")
            if path.exists():
                artist_bytes = path.read_bytes()
                result, source = json.loads(artist_bytes), str(ROOT)
            else:
                result = baseline[pid]
                artist_bytes = json_text(result).encode()
                source = result["source"]
                path = ROOT / "baseline.json"
            assert str(result["profileId"]) == pid and str(result["cmArtist"]) == cm
            matches = [c for c in result.get("candidates", [])
                       if handle(c.get("url")) == handle(selected["instagram_url"])
                       and (c.get("reviewSuggestion") is True
                            or c.get("review", {}).get("reviewSuggestion") is True)]
            assert len(matches) == 1, ("selected URL must resolve to exactly one positive finding", pid)
            candidate = matches[0]
            answer = candidate.get("recordedAnswer", {})
            assert answer.get("verdict") == selected["verdict"]
            probability = answer.get("sameIdentityProbability", answer.get("score"))
            assert str(probability) == selected["score"], ("selected score changed", pid)
            model, capture, request, state, model_path, capture_path = resolve_receipts(pid, candidate, source, indexes)
            capture_data, gaps = capture_fields(capture, candidate)
            context_data = catalog_fields(state, cm)
            decision = candidate.get("decision") or candidate.get("review") or {}
            guard = candidate.get("guard") or decision.get("guard")
            rules = {"policy": decision.get("policy"),
                     "verificationRules": state.get("verificationRules") if state else None,
                     "evidenceRules": state.get("evidenceRules") if state else None,
                     "guard": guard}
            fingerprint = json_sha(rules)
            rule_payloads[fingerprint] = rules
            discovered = result.get("allCandidates")
            if discovered is None and source != str(ROOT):
                target = next((t for t in indexes[source]["scope"]["targets"] if str(t["profileId"]) == pid), None)
                discovered = target.get("candidates", []) if target else None
            ranks = [i + 1 for i, c in enumerate(discovered or []) if handle(c.get("url")) == handle(candidate["url"])]
            model_data = model.get("data", {}) if model else {}
            rationale = model_data.get("rationale") or model_data.get("reasoning") or answer.get("rationale")
            rationale_status = "stored_text" if rationale else (
                "typed_choice_and_probability_only" if model else "model_response_receipt_not_found")
            if not model:
                gaps.append("model_response_receipt_not_found")
            if not state:
                gaps.append("original_model_state_not_found")
            evidence = candidate.get("discoveryEvidence")
            if evidence is None:
                evidence = (state or {}).get("savedSearchEvidence")
            other = [other_checked(c) for c in result.get("candidates", []) if c is not candidate]
            source_batch = Path(source).name if source != str(ROOT) else CAMPAIGN
            row = {
                "profile_id": pid, "cm_artist": cm,
                "artist_name": result.get("artist") or selected["artist_name"], "tier": int(selected["tier"]),
                "batch_id": CAMPAIGN, "source_batch_id": source_batch,
                "rules_version": decision.get("policy") or "not_recorded",
                "rules_fingerprint_sha256": fingerprint,
                "selected_url": selected["instagram_url"], "selected_handle": handle(selected["instagram_url"]),
                "serper_title": candidate.get("title"), "serper_snippet": candidate.get("snippet"),
                "serper_confidence": candidate.get("confidence"),
                "serper_confidence_source": "saved_discovery_candidate_field_not_serper_native_probability"
                    if candidate.get("confidence") is not None else "not_recorded",
                "serper_signals_json": json_text(candidate["signals"]) if "signals" in candidate else None,
                "serper_rank_among_candidates": ranks[0] if ranks else None,
                "serper_rank_basis": "saved_candidate_list_order" if ranks else "not_recorded",
                "serper_organic_position": serper_position(pid, selected["instagram_url"]) if source == str(ROOT) else None,
                "serper_evidence_json": json_text(evidence) if evidence is not None else None,
                **capture_data, **context_data,
                "jev_verdict": answer.get("verdict"), "jev_rationale_text": rationale,
                "jev_rationale_status": rationale_status, "jev_model": model_data.get("model"),
                "jev_requested_model": request.get("model"), "jev_timestamp": model.get("at") if model else None,
                "jev_same_identity_probability": probability,
                "jev_verdict_label_confidence": answer.get("verdictLabelConfidence"),
                "jev_verdict_probabilities_json": json_text(answer["verdictProbabilities"]) if "verdictProbabilities" in answer else None,
                "other_checked_candidates_json": json_text(other),
                "checked_candidate_count": len(result.get("candidates", [])),
                "discovered_candidate_count": len(discovered) if discovered is not None else None,
                "policy_decision_status": decision.get("status") or candidate.get("status"),
                "policy_decision_reason": decision.get("reason") or candidate.get("reason"),
                "guard_json": json_text(guard) if guard else None,
                "verification_rules_used_json": json_text(rules["verificationRules"]) if rules["verificationRules"] is not None else None,
                "evidence_rules_used_json": json_text(rules["evidenceRules"]) if rules["evidenceRules"] is not None else None,
                "original_request_sha256": candidate.get("requestSha256"),
                "original_model_state_available": state is not None,
                "artist_record_source_path": str(path), "artist_record_sha256": sha_bytes(artist_bytes),
                "capture_receipt_source_path": capture_path, "model_receipt_source_path": model_path,
                "evidence_gaps_json": json_text(gaps),
            }
            row = {name: row.get(name) for name in FIELDS}
            pending.append(row)
            csv_writer.writerow([csv_cell(row[name]) for name in FIELDS])
            summary["capture_status_counts"][row["capture_status"]] += 1
            summary["capture_source_counts"][row["capture_evidence_source"]] += 1
            raw_missing = capture is None
            none = row["capture_evidence_source"] == "none"
            unusable = row["capture_status"] != "ok"
            summary["raw_capture_receipts_found"] += int(not raw_missing)
            summary["raw_capture_receipts_missing"] += int(raw_missing)
            summary["no_saved_capture_evidence"] += int(none)
            summary["no_usable_capture"] += int(unusable)
            summary["model_receipts_missing"] += int(model is None)
            summary["rationale_status_counts"][rationale_status] += 1
            summary["evidence_gap_counts"].update(gaps)
            summary["null_counts"].update(k for k, v in row.items() if v is None)
            group = groups[(source_batch, row["rules_version"], fingerprint)]
            group["selected_rows"] += 1
            group["raw_capture_receipts_missing"] += int(raw_missing)
            group["no_saved_capture_evidence"] += int(none)
            group["no_usable_capture"] += int(unusable)
            if len(pending) == 500:
                writer.write_table(pa.Table.from_pylist(pending, schema=schema()))
                pending.clear()
            if (index + 1) % 5000 == 0:
                print(json_text({"exported": index + 1, "raw_capture_missing": summary["raw_capture_receipts_missing"]}), flush=True)
        if pending:
            writer.write_table(pa.Table.from_pylist(pending, schema=schema()))
    summary["batch_rules"] = [
        {"source_batch_id": source, "rules_version": policy, "rules_fingerprint_sha256": fingerprint, **counts}
        for (source, policy, fingerprint), counts in sorted(groups.items())
    ]
    with (OUTPUT / "batch-rules-and-capture-counts.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        dw = csv.DictWriter(stream, fieldnames=list(summary["batch_rules"][0]))
        dw.writeheader()
        dw.writerows(summary["batch_rules"])
    approvals = {"priority_original": read_json(ROOT / "approval.json")}
    for path in sorted(ROOT.glob("parallel-*/approval.json")):
        approvals[path.parent.name] = read_json(path)
    # Retain only technical provenance, not approval comments or unrelated personal context.
    runtime_manifest = {
        key: {k: value[k] for k in ("at", "runtimeFiles", "policyRuntime", "scopeSha256") if k in value}
        for key, value in approvals.items()
    }
    (OUTPUT / "recorded-rules-manifest.json").write_text(json.dumps({
        "recorded_rule_payloads": rule_payloads, "archived_runtime_approvals": runtime_manifest,
        "note": "Configuration inventory is not a per-artist executor attribution.",
    }, ensure_ascii=False, indent=2))
    summary["files"] = {p.name: {"bytes": p.stat().st_size, "sha256": sha_bytes(p.read_bytes())}
                        for p in (parquet_path, csv_path)}
    assert summary["files"][parquet_path.name]["bytes"] < LIMIT
    assert pq.ParquetFile(parquet_path).metadata.num_rows == 48333
    assert SELECTION.read_bytes() == source_bytes, "Selection changed while exporting"
    (OUTPUT / "export-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    write_readme(summary)
    print(json.dumps({k: v for k, v in summary.items()
                      if k not in ("null_counts", "batch_rules", "evidence_gap_counts")}, indent=2))


if __name__ == "__main__":
    main()
