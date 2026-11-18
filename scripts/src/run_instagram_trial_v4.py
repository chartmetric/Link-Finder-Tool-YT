"""Collect the fresh $20 trial without ever opening the evaluator's oracle."""
import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from instagram_proof_trial import digest, identity
from instagram_trial_transport import file_sha, save_new, utc
from instagram_trial_v4_rules import RULES, assess
from instagram_trial_v4_transport import Transport
from prepare_instagram_trial_v4 import ROOT
from rescore_instagram_trial_v4 import SavedEvidence
from run_instagram_locked_trial import Collector as OriginalCollector


class Collector(OriginalCollector):
    def page(self, artist, anchor, parent=None):
        # The original transport still supplies identity checking, bounded
        # public DNS/redirect handling and receipt-first writes. Re-extraction
        # here adds declared websites before the traversal queue is built.
        row = super().page(artist, anchor, parent)
        with self.transport.lock:
            saved = SavedEvidence(self.root)
        return saved.page(row)

    def collect_artist(self, artist):
        row = super().collect_artist(artist)
        with self.transport.lock:
            saved = SavedEvidence(self.root)
        candidates = []
        for candidate in row["candidates_checked"]:
            try:
                candidates.append(saved.candidate(candidate))
            except (ValueError, OSError, KeyError, TypeError) as error:
                candidates.append({**candidate, "status": "failed", "identity_bound": False,
                                   "v4_extraction_error": str(error)})
        progress = row["progress"]
        checked = {identity(r["url"]) for r in row["anchor_checks"]}
        missing = sorted({u for r in row["anchor_checks"] if r.get("status") == "ok"
                          for u in r.get("website_declarations", []) + r.get("hub_links", [])
                          if identity(u) not in checked})
        if missing:
            progress["anchor_followups_complete"] = False
        decision = assess(artist, row["anchor_checks"], candidates, progress)
        return {**row, **decision, "decided_at": utc(),
                "missing_owned_page_followups": missing, "rules_version": RULES}


def collect():
    scope = json.loads((ROOT / "scope.json").read_text())
    policy = json.loads((ROOT / "collection-policy.json").read_text())
    if (policy["inputs_sha256"] != file_sha(ROOT / "inputs.json")
            or policy["scope_sha256"] != digest(scope)):
        raise ValueError("Frozen trial inputs/scope changed")
    for name, sha in policy["source_code_hashes"].items():
        if file_sha(Path(__file__).parent / name) != sha:
            raise ValueError("Verdict/collection code changed after freeze")
    inputs = json.loads((ROOT / "inputs.json").read_text())
    if len(inputs) != 200 or Counter(a["group"] for a in inputs) != {"review": 100, "backtest": 100}:
        raise ValueError("Incorrect sample groups")
    output = ROOT / "artist-results"
    output.mkdir()
    transport = Transport(ROOT, scope, enabled=True)
    collector = Collector(ROOT, transport, policy)
    counts = Counter()
    with ThreadPoolExecutor(max_workers=6) as executor:
        futures = {executor.submit(collector.collect_artist, a): a for a in inputs}
        for future in as_completed(futures):
            artist = futures[future]
            try:
                row = future.result()
            except Exception as error:
                row = {k: artist[k] for k in ("profile_id", "cm_artist", "artist_name", "tier", "group")}
                row.update(run_id=scope["run_id"], rules_version=RULES, state="UNFINISHED",
                           reason_codes=["ARTIST_COLLECTION_EXCEPTION"], proof=[],
                           error_type=type(error).__name__, instagram_url=None, decided_at=utc())
            save_new(output / (artist["profile_id"] + ".json"), row)
            counts[row["state"]] += 1
            if sum(counts.values()) % 10 == 0:
                print(json.dumps({"finished_artists": sum(counts.values()), "counts": dict(counts),
                                  "paid_requests": transport.request_count,
                                  "guarded_liability_usd": transport.liability_microusd / 1e6,
                                  "halted": transport.halted.is_set()}), flush=True)
    frozen = {
        "run_id": scope["run_id"], "rules_version": RULES, "rows": 200, "frozen_at": utc(),
        "hashes": {p.name: file_sha(p) for p in sorted(output.glob("*.json"))},
        "counts": dict(counts), "halted": transport.halted.is_set(),
        "paid_requests": transport.request_count,
        "guarded_liability_usd": transport.liability_microusd / 1e6,
        "ledger_sha256": file_sha(ROOT / "admissions.jsonl"),
        "receipt_hashes": {p.name: file_sha(p) for p in sorted(transport.receipts.glob("*.json"))},
        "note": "All outcomes frozen before opening evaluator-only locked catalog links.",
    }
    save_new(ROOT / "decisions-frozen.json", frozen)
    save_new(ROOT / "TRIAL-CLOSED.json", {
        "run_id": scope["run_id"], "closed_at": utc(), "further_paid_dispatch_authorized": False,
        "unused_guard_allowance_retired_usd": 20 - frozen["guarded_liability_usd"],
        "full_run_authorized": False,
    })
    print(json.dumps({"completed_artists": 200, **{k: frozen[k] for k in (
        "counts", "halted", "paid_requests", "guarded_liability_usd")}}), flush=True)


if __name__ == "__main__":
    collect()
