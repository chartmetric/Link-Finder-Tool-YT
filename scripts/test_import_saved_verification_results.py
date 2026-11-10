"""Synthetic fixtures only: never asserts model accuracy or real artist outcomes."""
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("importer", Path(__file__).with_name("import_saved_verification_results.py"))
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.body = {"model": "fixture", "state": {"artist": "Fixture 日本語", "bio": "quoted,\n=not a formula"}}
        self.sha = hashlib.sha256(importer.text(self.body).encode()).hexdigest()
        self.request = dict(key="r1", profileId="1", artist="Fixture 日本語", role="candidate",
                            instagramUrl="https://www.instagram.com/fixture/", sha256=self.sha, body=self.body)
        self.result = dict(profileId="1", artist="Fixture 日本語", key="r1", role="candidate",
                           instagramUrl=self.request["instagramUrl"], score=0.99, verdict="verified",
                           researchPolicySupport=True, requestSha256=self.sha, metadataActuallyUsed=self.body["state"],
                           liveLinkAccepted=False)
        self.held = dict(profileId="2", artist="Held fixture", role="candidate", url="https://www.instagram.com/held/",
                         status="held_without_call", reason="saved_account_metadata_unavailable")
        self.none = dict(profileId="3", artist="Empty fixture", role="candidate", status="no_saved_candidate")
        self.summary = dict(status="completed", providerReportedCostUsd=0.0004,
                            budget=dict(budgetId="fixture-approval", reservedCents=2, maximumSpendCents=2000))

    def save(self, name, value):
        (self.root / name).write_text(importer.text(value))

    def prepare(self, results=None, sources=None):
        results = [self.result] if results is None else results
        sources = [self.held, self.none] if sources is None else sources
        self.save("scope.json", dict(artists=[dict(profile_id=str(i), artist=f"Artist {i}") for i in [1, 2, 3]],
                                    requests=[self.request]))
        self.save("summary.json", self.summary)
        self.save("source-rows.json", sources)
        (self.root / "results.jsonl").write_text("\n".join(importer.text(r) for r in results))
        columns = ["artist", "profileId", "role", "instagramUrl", "rubric", "status", "reason", "metadataActuallyUsed", "blank"]
        stream = io.StringIO(newline="")
        writer = csv.DictWriter(stream, fieldnames=columns)
        writer.writeheader()
        for r in [*results, *sources]:
            writer.writerow({k: importer.text(r.get("url") if k == "instagramUrl" and "url" in r else r.get(k)) for k in columns})
        (self.root / "artist-instagram-findings.csv").write_text(stream.getvalue())

    def build(self):
        return importer.build_document(self.root, self.root / "scope.json", "fixture", "Synthetic fixture",
                                       "2026-11-10T00:00:00Z", self.root / "source-rows.json")

    def test_research_only_exact_metadata_counts_held_and_no_candidate(self):
        self.prepare()
        doc = self.build()
        self.assertEqual(doc["batch"]["artistCount"], 3)
        self.assertEqual(doc["batch"]["verifiedCount"], 0)
        self.assertEqual([r["status"] for r in doc["rows"]], ["research_supported", "held", "no_candidate"])
        self.assertTrue(all(r["verifiedUrl"] is None for r in doc["rows"]))
        fields = {f["label"]: f["value"] for f in doc["rows"][0]["fields"]}
        self.assertEqual(json.loads(fields["Complete archived request actually sent (JSON)"]), self.body)
        self.assertEqual(fields["blank"], "")
        self.assertEqual(doc["batch"]["reservedUsd"], 0.02)
        self.assertEqual(doc["batch"]["reportedUsd"], 0.0004)
        self.assertEqual(self.build(), doc)

    def test_controls_shared_holds_partial_failures_and_missing_work(self):
        control = {**self.result, "profileId": "999", "role": "control", "requestSha256": None}
        shared = {**self.result, "profileId": "2", "sharedAcrossArtists": True, "requestSha256": None}
        failed = {**self.result, "profileId": "3", "status": "unresolved", "score": None, "requestSha256": None}
        self.prepare([control, shared, failed], [])
        doc = self.build()
        self.assertEqual(doc["batch"]["artistCount"], 3)  # missing result for prepared target 1 still visible
        self.assertEqual(doc["batch"]["verifiedCount"], 0)
        self.assertEqual([r["status"] for r in doc["rows"]], ["control", "shared_handle", "partial_failure", "skipped"])
        metrics = {m["label"]: m["value"] for m in doc["batch"]["metrics"]}
        self.assertEqual(metrics["Research-supported artists"], "0")
        self.assertEqual(metrics["Control comparisons"], "1")

    def test_mismatched_receipts_and_csv_fail_explicitly(self):
        self.prepare()
        self.result["metadataActuallyUsed"] = {"changed": True}
        self.prepare()
        with self.assertRaisesRegex(ValueError, "metadata differs"):
            self.build()
        self.result["metadataActuallyUsed"] = self.body["state"]
        self.prepare()
        (self.root / "artist-instagram-findings.csv").write_text("artist,profileId,role\nMissing,999,candidate\n")
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            self.build()

    def test_paired_requests_keep_baseline_and_proposed_separate(self):
        self.prepare(sources=[])
        (self.root / "requests").mkdir()
        bytes_ = importer.text(self.body).encode()
        (self.root / "requests/exact.json").write_bytes(bytes_)
        req = {k: v for k, v in self.request.items() if k != "body"}
        req.update(variant="baseline", requestFile="requests/exact.json")
        self.save("scope.json", dict(requests=[req]))
        doc = self.build()
        self.assertEqual(doc["rows"][0]["score"], 0.99)
        (self.root / "requests/exact.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "bytes do not match"):
            self.build()

    def test_paired_arms_retain_independent_scores_and_approval_accounting(self):
        first = {**self.result, "role": "candidate", "rubric": "baseline", "score": 0.5, "researchPolicySupport": False}
        second = {**self.result, "role": "candidate", "rubric": "proposed"}
        self.prepare([first, second], [])
        self.summary = dict(status="completed", reservedCents=48, maximumReservedCents=48,
                            providerReportedCostUsd=0.0016,
                            sharedBudget=dict(budgetId="original-pilot", maxSpendCents=1000, reservedSpendCents=996))
        self.save("summary.json", self.summary)
        doc = self.build()
        self.assertEqual([r["comparisonType"] for r in doc["rows"][:2]], ["baseline", "proposed"])
        self.assertEqual([r["score"] for r in doc["rows"][:2]], [0.5, 0.99])
        self.assertEqual(doc["batch"]["reservedUsd"], 0.48)
        metrics = {m["label"]: m["value"] for m in doc["batch"]["metrics"]}
        self.assertEqual(metrics["Separately approved run limit"], "$0.48")
        self.assertEqual(metrics["Shared pilot ceiling"], "$10.00")
        self.assertEqual(metrics["Shared pilot cumulative reservation"], "$9.96")

    def test_missing_files_never_produce_fake_results(self):
        with self.assertRaises(FileNotFoundError):
            self.build()


if __name__ == "__main__":
    unittest.main()
