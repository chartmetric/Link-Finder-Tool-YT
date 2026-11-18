"""Evaluate only frozen fresh predictions; keep development replay distinct."""
import csv
import json
import re
from collections import Counter, defaultdict
from decimal import Decimal

from instagram_proof_trial import digest, instagram_url
from instagram_trial_extract import provider_request
from instagram_trial_transport import file_sha, save_new, utc
from prepare_instagram_trial_v4 import ROOT
from rescore_instagram_trial_v4 import metrics


def frozen_rows():
    frozen = json.loads((ROOT / "decisions-frozen.json").read_text())
    if frozen["rows"] != 200 or len(frozen["hashes"]) != 200:
        raise ValueError("Do not evaluate an incomplete or unfrozen sample")
    inputs = {r["profile_id"]: r for r in json.loads((ROOT / "inputs.json").read_text())}
    rows = []
    for name, sha in frozen["hashes"].items():
        if not re.fullmatch(r"\d+\.json", name) or file_sha(ROOT / "artist-results" / name) != sha:
            raise ValueError("Frozen prediction changed")
        row = json.loads((ROOT / "artist-results" / name).read_text())
        bound = inputs[row["profile_id"]]
        if any(row[k] != bound[k] for k in ("profile_id", "cm_artist", "group")):
            raise ValueError("Prediction/sample identity mismatch")
        rows.append(row)
    if file_sha(ROOT / "admissions.jsonl") != frozen["ledger_sha256"]:
        raise ValueError("Admissions changed after freeze")
    for name, sha in frozen["receipt_hashes"].items():
        if file_sha(ROOT / "receipts" / name) != sha:
            raise ValueError("Saved evidence changed")
    policy = json.loads((ROOT / "collection-policy.json").read_text())
    if (policy["inputs_sha256"] != file_sha(ROOT / "inputs.json")
            or policy["scope_sha256"] != digest(json.loads((ROOT / "scope.json").read_text()))):
        raise ValueError("Frozen sample or approval scope changed")
    reference_lock = json.loads((ROOT / "reference-integrity-lock.json").read_text())
    if (not reference_lock["source_files_preexisted_launch"]
            or reference_lock["oracle_sha256"] != file_sha(ROOT / "oracle.evaluator-only.json")
            or reference_lock["pool_sha256"] != file_sha(ROOT / "locked-reference-pool.evaluator-only.json")):
        raise ValueError("Locked reference source changed")
    for name, sha in policy["source_code_hashes"].items():
        if file_sha(ROOT / "source-snapshots" / name) != sha:
            raise ValueError("Frozen code snapshot changed")
    return frozen, rows, inputs


def call_costs(frozen, rows, inputs):
    events = [json.loads(s) for s in (ROOT / "admissions.jsonl").read_text().splitlines()]
    reservations, acknowledgments, settled, pending = {}, {}, {}, 0
    for event in events:
        key, kind = event["request_id"], event["event"]
        if kind == "reserved":
            if key in reservations or digest({"kind": event["kind"], "params": event["payload"]}) != key:
                raise ValueError("Duplicate/unbound paid request")
            reservations[key] = event
            pending += event["reserved_microusd"]
        elif kind == "acknowledged":
            if key not in reservations or key in acknowledgments:
                raise ValueError("Unbound/duplicate provider acknowledgment")
            acknowledgments[key] = event
            if file_sha(ROOT / "receipts" / (key + ".json")) != event["receipt_sha256"]:
                raise ValueError("Charged receipt changed")
        elif kind == "settled":
            if key not in acknowledgments or key in settled:
                raise ValueError("Unbound/duplicate settlement")
            if (event["released_microusd"] < 0 or event["retained_microusd"] < 0
                    or event["released_microusd"] + event["retained_microusd"]
                    != reservations[key]["reserved_microusd"]):
                raise ValueError("Invalid charge settlement")
            settled[key] = event
            pending -= event["released_microusd"]
        elif kind != "uncertain" or key not in reservations:
            raise ValueError("Unknown or unbound budget event")
        if not 0 <= pending <= 20_000_000:
            raise ValueError("Guarded $20 ceiling exceeded")
    if (len(reservations) != frozen["paid_requests"]
            or abs(pending / 1e6 - frozen["guarded_liability_usd"]) > 1e-8):
        raise ValueError("Frozen spending summary differs")
    users = defaultdict(set)
    groups = {r["profile_id"]: r["group"] for r in rows}
    for row in rows:
        pid = row["profile_id"]
        name = re.sub(r'["\r\n]', " ", inputs[pid]["artist_name"]).strip()[:200]
        for query in (f'"{name}" musician Instagram site:instagram.com', f'"{name}" official Instagram artist'):
            key = digest({"kind": "serper", "params": {"q": query, "num": 10}})
            if key in reservations:
                users[key].add(pid)
        for anchor in row.get("anchor_checks", []):
            try:
                request = provider_request(anchor["url"])
                if request:
                    key = digest({"kind": request[0], "params": request[1]})
                    if key in reservations:
                        users[key].add(pid)
            except ValueError:
                pass
        for candidate in row.get("candidates_checked", []):
            key = digest({"kind": "instagram/profile",
                          "params": {"handle": candidate["url"].rstrip("/").split("/")[-1]}})
            if key in reservations:
                users[key].add(pid)
            for hub in candidate.get("hub_checks", []) + candidate.get("hub_errors", []):
                try:
                    request = provider_request(hub["url"])
                    if request:
                        key = digest({"kind": request[0], "params": request[1]})
                        if key in reservations:
                            users[key].add(pid)
                except ValueError:
                    pass
    known, unknown_upper = Decimal(0), Decimal(0)
    by_group, calls = defaultdict(Decimal), Counter()
    unattributed = []
    for key, reservation in reservations.items():
        calls[reservation["kind"]] += 1
        ack = acknowledgments.get(key)
        credits = ack.get("credits_charged") if ack else None
        if reservation["kind"] == "serper":
            value = Decimal(".001")
        elif type(credits) in (int, float):
            value = Decimal(str(credits)) * Decimal(".00188")
        else:
            value = Decimal(0)
            unknown_upper += Decimal(".0188")
        known += value
        if users[key]:
            for pid in users[key]:
                by_group[groups[pid]] += value / len(users[key])
        else:
            unattributed.append(key)
    return {
        "paid_requests": len(reservations), "duplicate_paid_admissions": 0,
        "calls_by_kind": dict(calls), "guarded_liability_usd": pending / 1e6,
        "approved_cap_usd": 20, "reference_consumption_low_usd": float(known),
        "reference_consumption_high_usd": float(known + unknown_upper),
        "reference_cost_per_artist_low_usd": float(known / 200),
        "reference_cost_per_artist_high_usd": float((known + unknown_upper) / 200),
        "reference_known_consumption_by_group_usd": {k: float(v) for k, v in by_group.items()},
        "unknown_charge_requests": sum(
            r["kind"] != "serper" and type(acknowledgments.get(k, {}).get("credits_charged"))
            not in (int, float) for k, r in reservations.items()),
        "unattributed_paid_requests": unattributed,
        "actual_account_purchase_price_unknown": True,
        "note": "Credit-value estimate at saved public reference prices, not an invoice. Unknown charges retain full guarded reservations.",
    }


def report():
    frozen, rows, inputs = frozen_rows()
    # The answer key is opened only after every prediction/receipt check above.
    reference = json.loads((ROOT / "oracle.evaluator-only.json").read_text())
    oracle = {r["profile_id"]: {instagram_url(u) for u in r["accepted_urls"]}
              for r in reference["controls"]}
    if set(oracle) != {r["profile_id"] for r in rows if r["group"] == "backtest"}:
        raise ValueError("Reference cohort differs")
    measured = metrics(rows, oracle)
    costs = call_costs(frozen, rows, inputs)
    agreement = measured["agreement_with_locked_catalog_links"]
    targets = {
        "agreement_at_least_95pct": agreement["agreement_pct_of_verified"] is not None
        and agreement["agreement_pct_of_verified"] >= 95,
        "wrong_not_found_at_most_5pct": agreement["wrong_not_found_pct_of_all_backtest"] <= 5,
        "collection_halted": frozen["halted"], "full_run_authorized": False,
    }
    result = {
        "run_id": frozen["run_id"], "reported_at": utc(), "evaluation_kind": "FRESH_BLINDED_TRIAL",
        "metrics": measured, "costs": costs, "targets": targets,
        "frozen_decisions_sha256": file_sha(ROOT / "decisions-frozen.json"),
        "reference_sha256": file_sha(ROOT / "oracle.evaluator-only.json"),
        "source_of_truth_label": "agreement with locked catalog links, not independent ownership accuracy",
    }
    save_new(ROOT / "trial-report.json", result)
    fields = ["profile_id", "cm_artist", "artist_name", "tier", "group", "state", "instagram_url", "rules_version"]
    with (ROOT / "fresh-all-200.csv").open("x", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields + ["proof", "unfinished_checks"])
        writer.writeheader()
        for row in rows:
            writer.writerow({**{k: row.get(k) for k in fields},
                             "proof": json.dumps(row.get("proof", []), ensure_ascii=False),
                             "unfinished_checks": json.dumps(row.get("unfinished_checks", []))})
    with (ROOT / "fresh-all-200-audit.jsonl").open("x") as stream:
        for row in rows:
            stream.write(json.dumps({**row, "catalog_context": inputs[row["profile_id"]]}, ensure_ascii=False) + "\n")
    with (ROOT / "backtest-comparison.csv").open("x", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=[
            "profile_id", "cm_artist", "artist_name", "state", "selected_url", "locked_reference_urls", "matches_reference"])
        writer.writeheader()
        for row in rows:
            if row["group"] == "backtest":
                writer.writerow({
                    "profile_id": row["profile_id"], "cm_artist": row["cm_artist"], "artist_name": row["artist_name"],
                    "state": row["state"], "selected_url": row["instagram_url"],
                    "locked_reference_urls": json.dumps(sorted(oracle[row["profile_id"]])),
                    "matches_reference": (instagram_url(row["instagram_url"]) in oracle[row["profile_id"]])
                    if row["state"] == "VERIFIED" else ""})
    print(json.dumps(result))


if __name__ == "__main__":
    report()
