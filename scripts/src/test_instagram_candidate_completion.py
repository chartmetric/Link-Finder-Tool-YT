import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from complete_instagram_trial_candidates import complete
from instagram_proof_trial import digest
from instagram_trial_transport import file_sha, save_new


def fixture(parent):
    results = parent / "artist-results-continuation"
    results.mkdir()
    (parent / "receipts").mkdir()
    inputs, events = [], []
    for i in range(200):
        row = {"profile_id": str(i), "group": "review" if i < 100 else "backtest",
               "artist_name": "Fixture " + str(i)}
        inputs.append(row)
        save_new(results / (str(i) + ".json"), row)
        for q in (f'"{row["artist_name"]}" musician Instagram site:instagram.com',
                  f'"{row["artist_name"]}" official Instagram artist'):
            params = {"q": q, "num": 10}
            events.append({"event": "reserved", "kind": "serper", "payload": params,
                           "request_id": digest({"kind": "serper", "params": params}),
                           "reserved_cents": 2})
    save_new(parent / "inputs.json", inputs)
    save_new(parent / "scope.json", {"run_id": "fixture", "max_spend_usd": 60,
                                    "max_candidate_captures_per_artist": 3})
    save_new(parent / "continuation-policy.json", {"inputs_sha256": file_sha(parent / "inputs.json")})
    save_new(parent / "decisions-continuation-frozen.json", {
        "run_id": "fixture", "rows": 200, "halted": False, "reserved_usd": 8,
        "hashes": {p.name: file_sha(p) for p in results.glob("*.json")}})
    save_new(parent / "final-output.json", {
        "results_directory": results.name, "decisions_manifest": "decisions-continuation-frozen.json",
        "policy_file": "continuation-policy.json",
        "decisions_sha256": file_sha(parent / "decisions-continuation-frozen.json")})
    save_new(parent / "table-created.json", {"table": "fixture"})
    (parent / "oracle.evaluator-only.json").write_bytes(b"opaque-hidden-control-labels")
    (parent / "admissions.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))


class CompletionTests(unittest.TestCase):
    def test_same_inputs_same_budget_prior_charges_and_hidden_oracle_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            parent, child = Path(d), Path(d) / "child"
            fixture(parent)
            before = file_sha(parent / "admissions.jsonl")
            with patch("complete_instagram_trial_candidates.collect") as run:
                complete(parent, child)
                run.assert_called_once_with(child, continuation=True)
            scope = json.loads((child / "scope.json").read_text())
            self.assertEqual(scope["max_spend_usd"], 60)
            self.assertEqual(scope["max_candidate_captures_per_artist"], 50)
            self.assertEqual(file_sha(child / "inputs.json"), file_sha(parent / "inputs.json"))
            self.assertEqual(file_sha(child / "admissions.jsonl"), before)
            self.assertEqual(file_sha(parent / "admissions.jsonl"), before)
            self.assertEqual((child / "oracle.evaluator-only.json").read_bytes(), b"opaque-hidden-control-labels")

    def test_a_missing_search_tombstone_prevents_new_paid_launch(self):
        with tempfile.TemporaryDirectory() as d:
            parent, child = Path(d), Path(d) / "child"
            fixture(parent)
            p = parent / "admissions.jsonl"
            p.write_text("".join(p.read_text().splitlines(keepends=True)[1:]))
            with patch("complete_instagram_trial_candidates.collect") as run:
                with self.assertRaisesRegex(ValueError, "new searches"):
                    complete(parent, child)
                run.assert_not_called()
            self.assertFalse(child.exists())

    def test_changed_parent_results_prevent_retirement_and_launch(self):
        with tempfile.TemporaryDirectory() as d:
            parent, child = Path(d), Path(d) / "child"
            fixture(parent)
            (parent / "artist-results-continuation" / "0.json").write_text("{}")
            with patch("complete_instagram_trial_candidates.collect") as run:
                with self.assertRaisesRegex(ValueError, "decision audit"):
                    complete(parent, child)
                run.assert_not_called()
            self.assertFalse((parent / "retired-to-candidate-completion.json").exists())


if __name__ == "__main__":
    unittest.main()
