"""Complete the same blinded trial under its one shared approval.

Retire the parent executor, copy its immutable receipts and full admission
history, then inspect remaining saved-search candidates. Never buy searches
again, change the cohort, unblind the oracle or replenish the allowance.
"""
import fcntl
import json
import re
import shutil
from pathlib import Path

from instagram_proof_trial import digest
from instagram_trial_transport import file_sha, save_new, utc
from prepare_instagram_locked_trial import ROOT
from run_instagram_locked_trial import collect

CHILD = ROOT / "candidate-completion"


def complete(parent=ROOT, child=CHILD):
    # This is an execution fence, not polling: no child admissions until
    # the preceding executor has exited and released its exclusive lock.
    with (parent / "collector.lock").open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        return complete_locked(parent, child)


def complete_locked(parent, child):
    if child.exists() or (parent / "retired-to-candidate-completion.json").exists():
        raise ValueError("Candidate completion already prepared; reconcile before another launch")
    pointer = json.loads((parent / "final-output.json").read_text())
    frozen_path = parent / pointer["decisions_manifest"]
    frozen = json.loads(frozen_path.read_text())
    if frozen.get("halted") or frozen["rows"] != 200:
        raise ValueError("Parent trial did not reach a clean frozen boundary")
    if file_sha(frozen_path) != pointer["decisions_sha256"]:
        raise ValueError("Frozen parent changed")
    scope = json.loads((parent / "scope.json").read_text())
    inputs = json.loads((parent / "inputs.json").read_text())
    policy = json.loads((parent / pointer["policy_file"]).read_text())
    if policy["inputs_sha256"] != file_sha(parent / "inputs.json"):
        raise ValueError("Original sample changed")
    groups = {g: sum(r["group"] == g for r in inputs) for g in ("review", "backtest")}
    if (groups != {"review": 100, "backtest": 100} or scope["max_spend_usd"] != 60
            or scope["run_id"] != frozen["run_id"]):
        raise ValueError("Original cohort/budget differs")
    reservations = [json.loads(s) for s in (parent / "admissions.jsonl").read_text().splitlines()
                    if s.strip() and json.loads(s)["event"] == "reserved"]
    keys = {r["request_id"] for r in reservations}
    if len(keys) != len(reservations) or sum(r["reserved_cents"] for r in reservations) > 6000:
        raise ValueError("Duplicate or over-budget prior operations")
    for artist in inputs:
        name = re.sub(r'["\r\n]', " ", artist["artist_name"]).strip()[:200]
        for q in (f'"{name}" musician Instagram site:instagram.com', f'"{name}" official Instagram artist'):
            if digest({"kind": "serper", "params": {"q": q, "num": 10}}) not in keys:
                raise ValueError("Do not buy new searches during candidate completion")
    for filename, expected in frozen["hashes"].items():
        if file_sha(parent / pointer["results_directory"] / filename) != expected:
            raise ValueError("Parent decision audit changed")
    save_new(parent / "retired-to-candidate-completion.json", {
        "run_id": scope["run_id"], "at": utc(), "child_directory": child.name,
        "parent_frozen_sha256": file_sha(frozen_path),
        "parent_admissions_sha256": file_sha(parent / "admissions.jsonl"),
        "reserved_usd_preserved": frozen["reserved_usd"],
        "new_total_allowance_usd": 60, "allowance_replenished": False,
        "parent_may_admit_new_requests": False,
    })
    child.mkdir()
    for filename in ("inputs.json", "admissions.jsonl", "table-created.json"):
        shutil.copy2(parent / filename, child / filename)
    shutil.copytree(parent / "receipts", child / "receipts")
    # The evaluator-only file is copied byte-for-byte without parsing or using
    # its contents in sourcing. Known Instagram links remain hidden inputs.
    shutil.copy2(parent / "oracle.evaluator-only.json", child / "oracle.evaluator-only.json")
    effective_scope = {**scope, "max_candidate_captures_per_artist": 50,
                       "parent_scope_sha256": file_sha(parent / "scope.json")}
    save_new(child / "scope.json", effective_scope)
    effective_policy = {
        **policy, "candidate_capture_bound": 50,
        "scope_sha256": digest(effective_scope),
        "parent_collection_policy_sha256": file_sha(parent / pointer["policy_file"]),
        "parent_frozen_decisions_sha256": file_sha(frozen_path),
        "prior_admissions_sha256": file_sha(child / "admissions.jsonl"),
        "candidate_completion_at": utc(),
        "prior_receipt_hashes": {p.name: file_sha(p) for p in (child / "receipts").glob("*.json")},
        "completion_reason": (
            "Complete remaining saved-search candidates for the same 200 blinded artists "
            "under the original total $60 approval; no new searches, cohort or model calls."),
        "source_code_hashes": {p: file_sha(Path(__file__).parent / p) for p in (
            "run_instagram_locked_trial.py", "instagram_trial_extract.py", "instagram_trial_transport.py")},
        "completion_code_sha256": file_sha(Path(__file__)),
    }
    save_new(child / "continuation-policy.json", effective_policy)
    print(json.dumps({"completion": "SAME_200_ARTISTS_SAME_60_DOLLAR_TOTAL",
                      "prior_reserved_usd": frozen["reserved_usd"],
                      "paid_retries_permitted": False}), flush=True)
    collect(child, continuation=True)


if __name__ == "__main__":
    complete()
