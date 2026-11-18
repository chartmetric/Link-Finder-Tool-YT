"""Project actually checked, unselected campaign candidates from saved archives."""

import csv
import json
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from export_instagram_selected_evidence import FIELDS, schema, serper_position
from instagram_clickhouse_import import EXTRA_ASSESSED, STATE
from instagram_saved_export_helpers import (
    CAMPAIGN, ROOT, capture_fields, catalog_fields, handle, json_sha, json_text,
    is_assessed_candidate, legacy_indexes, other_checked, read_json, resolve_receipts, sha_bytes,
)

SELECTED_DIR = Path("generated-artifacts/instagram-likely-export-after-continuation")


def reason_for(candidate, profile_id, corrections):
    key = (profile_id, handle(candidate["url"]))
    if key in corrections:
        return corrections[key], "explicit_user_approved_export_correction"
    decision = candidate.get("decision") or candidate.get("review") or {}
    if decision.get("reason"):
        return decision["reason"], "saved_policy_decision"
    if candidate.get("reason"):
        return candidate["reason"], "saved_candidate_outcome"
    if candidate.get("status"):
        return candidate["status"], "saved_status_no_further_reason_stored"
    return "not_in_corrected_selected_export; no specific reason recorded", "export_membership_only_not_identity_rejection"


def export_artist(item, selection, baseline, indexes, corrections):
    pid, identity = item
    path = ROOT / "artists" / (pid + ".json")
    if path.exists():
        raw = path.read_bytes()
        result = json.loads(raw)
        source = str(ROOT)
    elif pid in baseline:
        result = baseline[pid]
        raw = json_text(result).encode()
        source = result["source"]
        path = ROOT / "baseline.json"
    else:
        return [], 0
    assert str(result["profileId"]) == pid and str(result["cmArtist"]) == str(identity["cm_artist"])
    chosen = selection.get(pid)
    original_findings = result.get("candidates", [])
    findings = [c for c in original_findings if is_assessed_candidate(c)]
    uninspected_excluded = len(original_findings) - len(findings)
    discovered = result.get("allCandidates")
    if discovered is None and source != str(ROOT):
        target = next((t for t in indexes[source]["scope"]["targets"] if str(t["profileId"]) == pid), None)
        discovered = target.get("candidates") if target else None
    rows = []
    seen = set()
    for candidate in findings:
        candidate_handle = handle(candidate.get("url"))
        assert candidate_handle, ("assessed candidate URL is not an Instagram profile", pid)
        if chosen and candidate_handle == handle(chosen["instagram_url"]):
            continue
        assert candidate_handle not in seen, ("duplicate checked artist/handle", pid)
        seen.add(candidate_handle)
        model, capture, request, state, model_path, capture_path = resolve_receipts(pid, candidate, source, indexes)
        capture_data, gaps = capture_fields(capture, candidate, allow_handle_conflict=True)
        context_data = catalog_fields(state, str(identity["cm_artist"]))
        model_data = model.get("data", {}) if model else {}
        saved_answer = candidate.get("recordedAnswer") or {}
        raw_answers = model_data.get("answers", {})
        answer = saved_answer or {
            "verdict": raw_answers.get("candidate_0_verdict", {}).get("choice"),
            "sameIdentityProbability": raw_answers.get("candidate_0_same_identity", {}).get("noul"),
            "verdictLabelConfidence": raw_answers.get("candidate_0_verdict", {}).get("confidence"),
            "verdictProbabilities": raw_answers.get("candidate_0_verdict", {}).get("probabilities"),
        }
        verdict_source = ("recorded_artist_outcome" if saved_answer.get("verdict")
                          else "saved_model_response_only" if answer.get("verdict") else "none")
        decision = candidate.get("decision") or candidate.get("review") or {}
        policy = decision.get("policy") or "not_recorded"
        guard = candidate.get("guard") or decision.get("guard")
        rules = {"policy": policy if policy != "not_recorded" else None,
                 "verificationRules": state.get("verificationRules") if state else None,
                 "evidenceRules": state.get("evidenceRules") if state else None, "guard": guard}
        ranks = [i + 1 for i, c in enumerate(discovered or []) if handle(c.get("url")) == candidate_handle]
        reason, reason_source = reason_for(candidate, pid, corrections)
        rationale = model_data.get("rationale") or model_data.get("reasoning") or saved_answer.get("rationale")
        if not model:
            gaps.append("model_response_receipt_not_found")
        if not state:
            gaps.append("original_model_state_not_found")
        original_hash = candidate.get("requestSha256") or (model.get("requestBodySha256") if model else None)
        if not original_hash and model and source == str(ROOT):
            key = model["operationKey"].removeprefix("model-")
            original_hash = read_json(ROOT / "inputs" / (key + ".json"))["requestSha256"]
        evidence = candidate.get("discoveryEvidence")
        if evidence is None:
            evidence = (state or {}).get("savedSearchEvidence")
        row = {
            "profile_id": pid, "cm_artist": str(identity["cm_artist"]),
            "artist_name": result.get("artist"), "tier": int(result.get("tier") or identity["tier"]),
            "batch_id": CAMPAIGN,
            "source_batch_id": Path(source).name if source != str(ROOT) else CAMPAIGN,
            "rules_version": policy, "rules_fingerprint_sha256": json_sha(rules),
            # selected_url continues to mean the artist's selected URL, not this
            # unselected account. candidate_url is the assessed row's identity.
            "selected_url": chosen["instagram_url"] if chosen else None,
            "selected_handle": handle(chosen["instagram_url"]) if chosen else None,
            "serper_title": candidate.get("title"), "serper_snippet": candidate.get("snippet"),
            "serper_confidence": candidate.get("confidence"),
            "serper_confidence_source": "saved_discovery_candidate_field_not_serper_native_probability"
                if candidate.get("confidence") is not None else "not_recorded",
            "serper_signals_json": json_text(candidate["signals"]) if "signals" in candidate else None,
            "serper_rank_among_candidates": ranks[0] if ranks else None,
            "serper_rank_basis": "saved_candidate_list_order" if ranks else "not_recorded",
            "serper_organic_position": serper_position(pid, candidate["url"]) if source == str(ROOT) else None,
            "serper_evidence_json": json_text(evidence) if evidence is not None else None,
            **capture_data, **context_data,
            "jev_verdict": answer.get("verdict"), "jev_rationale_text": rationale,
            "jev_rationale_status": "stored_text" if rationale else
                "typed_choice_and_probability_only" if answer.get("verdict") else "no_model_verdict_stored",
            "jev_model": model_data.get("model"), "jev_requested_model": request.get("model"),
            "jev_timestamp": model.get("at") if model else None,
            "jev_same_identity_probability": answer.get("sameIdentityProbability", answer.get("score")),
            "jev_verdict_label_confidence": answer.get("verdictLabelConfidence"),
            "jev_verdict_probabilities_json": json_text(answer["verdictProbabilities"])
                if answer.get("verdictProbabilities") is not None else None,
            "other_checked_candidates_json": json_text([other_checked(c) for c in findings if c is not candidate]),
            "checked_candidate_count": len(findings),
            "discovered_candidate_count": len(discovered) if discovered is not None else None,
            "policy_decision_status": decision.get("status") or candidate.get("status"),
            "policy_decision_reason": decision.get("reason") or candidate.get("reason"),
            "guard_json": json_text(guard) if guard else None,
            "verification_rules_used_json": json_text(rules["verificationRules"]) if rules["verificationRules"] is not None else None,
            "evidence_rules_used_json": json_text(rules["evidenceRules"]) if rules["evidenceRules"] is not None else None,
            "original_request_sha256": original_hash, "original_model_state_available": state is not None,
            "artist_record_source_path": str(path), "artist_record_sha256": sha_bytes(raw),
            "capture_receipt_source_path": capture_path, "model_receipt_source_path": model_path,
            "evidence_gaps_json": json_text(gaps),
            "candidate_url": candidate["url"], "candidate_handle": candidate_handle,
            "not_selected_reason": reason, "not_selected_reason_source": reason_source,
            "model_verdict_source": verdict_source,
        }
        rows.append({key: row.get(key) for key in FIELDS + [f.name for f in EXTRA_ASSESSED]})
    return rows, uninspected_excluded


def main():
    manifest = read_json(STATE / "publication.json")
    assert manifest["tables_created"] == ["musician_instagram_selected", "musician_instagram_candidates_assessed"]
    with (SELECTED_DIR / "instagram-selected-links-for-unverified-import.csv").open(encoding="utf-8-sig", newline="") as f:
        selection = {r["profile_id"]: r for r in csv.DictReader(f)}
    assert len(selection) == 48333
    baseline = {str(r["profileId"]): r for r in read_json(ROOT / "baseline.json")}
    indexes = {source: legacy_indexes(source) for source in sorted({r["source"] for r in baseline.values()})}
    corrections = {}
    for index in range(1, 5):
        audit = read_json(SELECTED_DIR / ("correction-audit" + ("" if index == 1 else "-" + str(index)) + ".json"))
        for row in audit["excluded"]:
            corrections[(row["profile_id"], handle(row["instagram_url"]))] = audit["reason"]
    queue = {str(r["profile_id"]): r for r in read_json(ROOT / "queue.json")}
    assert len(queue) == 76068
    output = STATE / "instagram-candidates-assessed.parquet"
    assert not output.exists(), "Do not overwrite an existing assessed export"
    staged = STATE / "building-assessed.parquet"
    arrow_schema = pa.schema(list(schema()) + EXTRA_ASSESSED)
    counts = Counter()
    profiles = set()
    groups = Counter()
    nulls = Counter()
    rows_written = 0
    uninspected_excluded = 0
    pending = []
    with pq.ParquetWriter(staged, arrow_schema, compression="zstd") as writer, \
            ThreadPoolExecutor(max_workers=12) as executor:
        items = list(queue.items())
        for start in range(0, len(items), 96):
            results = executor.map(lambda item: export_artist(item, selection, baseline, indexes, corrections),
                                   items[start:start + 96])
            for rows, excluded in results:
                uninspected_excluded += excluded
                if not rows:
                    continue
                pending.extend(rows)
                if len(pending) >= 1000:
                    writer.write_table(pa.Table.from_pylist(pending, schema=arrow_schema))
                    pending.clear()
                for row in rows:
                    profiles.add(row["profile_id"])
                    counts[row["capture_status"] if row["capture_evidence_source"] != "none" else "no capture found"] += 1
                    counts["no_model_verdict"] += int(not row["jev_verdict"])
                    groups[(row["source_batch_id"], row["rules_version"])] += 1
                    nulls.update(k for k, v in row.items() if v is None)
                rows_written += len(rows)
            if start % 9600 == 0:
                print(json_text({"artists_scanned": min(start + 96, len(items)), "assessed_rows": rows_written}), flush=True)
        if pending:
            writer.write_table(pa.Table.from_pylist(pending, schema=arrow_schema))
    staged.replace(output)
    report = {
        "scope": "All actually checked but unselected candidates in the original 76068-artist campaign; unchecked search hits excluded.",
        "rows": rows_written, "distinct_profile_ids": len(profiles),
        "uninspected_candidates_excluded": uninspected_excluded,
        "capture_and_verdict_counts": dict(counts), "null_counts": dict(nulls),
        "rules_by_batch": [{"source_batch_id": a, "rules_version": b, "rows": n} for (a, b), n in sorted(groups.items())],
        "sha256": sha_bytes(output.read_bytes()), "bytes": output.stat().st_size,
        "provider_calls": 0, "catalog_writes": 0,
        "selected_url_semantics": "Selected artist URL, if one exists; candidate_url identifies this unselected assessment.",
    }
    (STATE / "assessed-export-summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
