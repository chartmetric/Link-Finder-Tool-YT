"""Saved-data-only development replay. Never a held-out accuracy measurement."""
import copy
import csv
import json
from collections import Counter
from pathlib import Path

from instagram_proof_trial import digest, identity, instagram_url
from instagram_trial_extract import provider_request, website_links
from instagram_trial_transport import file_sha, save_new, utc
from instagram_trial_v4_rules import RULES, assess
from instagram_trial_v4_sources import is_hub, profile_links

OLD = Path("generated-artifacts/instagram-proof-trial-locked-100plus100-2026-11-17/candidate-completion")
ROOT = Path("generated-artifacts/instagram-proof-first-v4-2026-11-18")


class SavedEvidence:
    def __init__(self, root):
        self.root = root
        self.acks = {}
        for line in (root / "admissions.jsonl").read_text().splitlines():
            event = json.loads(line)
            if event["event"] == "acknowledged":
                self.acks[event["request_id"]] = event["receipt_sha256"]

    def packet(self, row, url=None, kind=None, params=None):
        rid = row.get("receipt_id")
        if not rid and kind:
            rid = digest({"kind": kind, "params": params})
        if not rid:
            raise ValueError("No saved receipt")
        path = self.root / "receipts" / (rid + ".json")
        expected = row.get("capture_sha256") or self.acks.get(rid)
        if not expected or file_sha(path) != expected:
            raise ValueError("Missing or changed saved receipt")
        packet = json.loads(path.read_text())
        if kind and (packet.get("kind") != kind or packet.get("params") != params):
            raise ValueError("Saved operation identity differs")
        if not kind and identity(packet.get("source_url")) != identity(url):
            raise ValueError("Saved public source identity differs")
        return packet, rid, expected

    def page(self, row):
        request = provider_request(row["url"])
        kind, params = request if request else (None, None)
        packet, rid, sha = self.packet(row, row["url"], kind, params)
        if kind:
            normalized = profile_links(kind, row["url"], packet)
        else:
            if is_hub(row["url"]):
                raise ValueError("Unscoped hub HTML is not an artist-declared link inventory")
            normalized = website_links(packet)
            normalized["hub_links"] = [x for x in normalized["links"] if is_hub(x)]
        return {**row, **normalized, "status": "ok", "identity_bound": True,
                "receipt_id": rid, "capture_sha256": sha, "observed_at": packet["at"]}

    def candidate(self, row):
        params = {"handle": row["url"].rstrip("/").split("/")[-1]}
        packet, rid, sha = self.packet(row, kind="instagram/profile", params=params)
        normalized = profile_links("instagram/profile", row["url"], packet)
        result = {**row, **normalized, "status": "ok", "identity_bound": True,
                  "receipt_id": rid, "capture_sha256": sha, "observed_at": packet["at"],
                  "followups_complete": True, "hub_receipt_ids": [], "hub_checks": [],
                  "prior_hub_checks": row.get("hub_checks", [])}
        by_url = {identity(x["url"]): x for x in row.get("hub_checks", [])}
        queue, seen = list(result["hub_links"]), set()
        while queue:
            url = queue.pop(0)
            key = identity(url)
            if key in seen:
                continue
            seen.add(key)
            saved = by_url.get(key)
            if not saved:
                result["followups_complete"] = False
                result.setdefault("hub_errors", []).append({
                    "url": url, "reason": "REQUIRED_LINK_HUB_NOT_CAPTURED_IN_SAVED_TRIAL"})
                continue
            try:
                hub = self.page(saved)
                result["hub_checks"].append(hub)
                result["hub_receipt_ids"].append(hub["receipt_id"])
                result["links"] += hub["links"]
                queue += hub["hub_links"]
            except (ValueError, OSError, KeyError, TypeError) as error:
                result["followups_complete"] = False
                result.setdefault("hub_errors", []).append({"url": url, "reason": str(error)})
        result["links"] = sorted(set(result["links"]))
        return result


def metrics(rows, oracle):
    result = {}
    for group in ("review", "backtest"):
        selected = [r for r in rows if r["group"] == group]
        counts = Counter(r["state"] for r in selected)
        result[group] = {"artists": len(selected), **{
            key: counts[key] for key in ("VERIFIED", "NOT_FOUND", "MANUAL_REVIEW", "UNFINISHED")}}
    controls = [r for r in rows if r["group"] == "backtest"]
    verified = [r for r in controls if r["state"] == "VERIFIED"]
    same = sum(instagram_url(r["instagram_url"]) in oracle[r["profile_id"]] for r in verified)
    result["agreement_with_locked_catalog_links"] = {
        "same": same, "different": len(verified) - same, "verified_backtest": len(verified),
        "agreement_pct_of_verified": round(100 * same / len(verified), 4) if verified else None,
        "same_pct_of_all_backtest": round(100 * same / len(controls), 4),
        "wrong_not_found": result["backtest"]["NOT_FOUND"],
        "wrong_not_found_pct_of_all_backtest": round(100 * result["backtest"]["NOT_FOUND"] / len(controls), 4),
        "independently_reviewed_accuracy": False,
    }
    return result


def rescore():
    out = ROOT / "saved-evidence-rescore"
    out.mkdir(parents=True)
    original = [json.loads(s) for s in (OLD / "trial-all-200-audit.jsonl").read_text().splitlines()]
    frozen = json.loads((OLD / "decisions-adjudicated-frozen.json").read_text())
    for name, sha in frozen["hashes"].items():
        if file_sha(OLD / "artist-results-adjudicated" / name) != sha:
            raise ValueError("Original frozen decisions changed")
    inputs = {r["profile_id"]: r for r in json.loads((OLD / "inputs.json").read_text())}
    evidence, updated = SavedEvidence(OLD), []
    for row in original:
        anchors, candidates = [], []
        for anchor in row["anchor_checks"]:
            try:
                anchors.append(evidence.page(anchor))
            except (ValueError, OSError, KeyError, TypeError) as error:
                anchors.append({**anchor, "status": "failed", "identity_bound": False,
                                "v4_replay_error": str(error)})
        for candidate in row["candidates_checked"]:
            try:
                candidates.append(evidence.candidate(candidate))
            except (ValueError, OSError, KeyError, TypeError) as error:
                candidates.append({**candidate, "status": "failed", "identity_bound": False,
                                   "v4_replay_error": str(error)})
        progress = copy.deepcopy(row["progress"])
        checked = {identity(a["url"]) for a in anchors}
        missing = sorted({u for a in anchors if a.get("status") == "ok"
                          for u in a.get("website_declarations", []) + a.get("hub_links", [])
                          if identity(u) not in checked})
        if missing:
            progress["anchor_followups_complete"] = False
        decision = assess(inputs[row["profile_id"]], anchors, candidates, progress)
        updated.append({**row, **decision, "rules_version": RULES, "decided_at": utc(),
                        "before_state": row["state"], "before_instagram_url": row["instagram_url"],
                        "anchor_checks": anchors, "progress": progress,
                        "missing_owned_page_followups": missing,
                        "historical_run_id": row["run_id"], "evaluation_kind": "UNBLINDED_DEVELOPMENT_REPLAY",
                        "new_paid_calls": 0})
    with (out / "rescored-all-200-audit.jsonl").open("x") as stream:
        for row in updated:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    # Only evaluate after all new decisions have been persisted.
    reference = json.loads((OLD / "oracle.evaluator-only.json").read_text())
    oracle = {a["profile_id"]: {instagram_url(u) for u in a["accepted_urls"]}
              for a in reference["controls"]}
    before, after = metrics(original, oracle), metrics(updated, oracle)
    report = {
        "rules_version": RULES, "evaluation_kind": "UNBLINDED_DEVELOPMENT_REPLAY_NOT_HELD_OUT",
        "before": before, "after": after, "new_paid_calls": 0,
        "original_decisions_sha256": file_sha(OLD / "decisions-adjudicated-frozen.json"),
        "original_complete_audit_sha256": file_sha(OLD / "trial-all-200-audit.jsonl"),
        "rescored_audit_sha256": file_sha(out / "rescored-all-200-audit.jsonl"),
        "changes": [{"profile_id": r["profile_id"], "artist_name": r["artist_name"],
                     "before": r["before_state"], "after": r["state"]}
                    for r in updated if r["state"] != r["before_state"]],
    }
    save_new(out / "before-after.json", report)
    fields = ["profile_id", "cm_artist", "artist_name", "tier", "group", "before_state",
              "state", "before_instagram_url", "instagram_url", "rules_version"]
    with (out / "rescored-all-200.csv").open("x", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields + ["proof", "unfinished_checks"])
        writer.writeheader()
        for row in updated:
            writer.writerow({**{k: row.get(k) for k in fields},
                             "proof": json.dumps(row["proof"], ensure_ascii=False),
                             "unfinished_checks": json.dumps(row["unfinished_checks"])})
    print(json.dumps({"before": before, "after": after, "changed": len(report["changes"]),
                      "new_paid_calls": 0}, ensure_ascii=False))


if __name__ == "__main__":
    rescore()
