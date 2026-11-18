"""Join frozen decisions to their complete, pre-adjudication capture audit.

Decision filtering is not permission to remove rejected captures from audit
exports or cost allocation. No verdict or proof is changed by this join.
"""
import json

from instagram_trial_transport import file_sha


def complete_audit_row(root, filename, row):
    if not row.get("adjudication"):
        return row
    path = root / "artist-results-continuation" / filename
    expected = row["adjudication"]["parent_decision_sha256"]
    if file_sha(path) != expected:
        raise ValueError("Complete pre-adjudication capture audit changed")
    original = json.loads(path.read_text())
    if any(original[k] != row[k] for k in ("profile_id", "cm_artist", "group", "artist_name")):
        raise ValueError("Complete capture audit belongs to another artist")
    captured = original.get("candidates_checked", [])
    by_url = {c["url"]: c for c in captured}
    if len(by_url) != len(captured) or any(
            by_url.get(c["url"]) != c for c in row.get("candidates_checked", [])):
        raise ValueError("Decision used candidates outside the frozen capture audit")
    return {
        **row,
        "decision_candidates_checked": row.get("candidates_checked", []),
        "candidates_checked": captured,
        "complete_capture_audit_sha256": expected,
        "decision_changed_by_evidence_join": False,
    }
