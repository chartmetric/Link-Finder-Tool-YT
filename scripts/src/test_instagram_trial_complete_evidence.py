import json
import tempfile
import unittest
from pathlib import Path

from instagram_trial_complete_evidence import complete_audit_row
from instagram_trial_transport import file_sha, save_new


class EvidenceJoinTests(unittest.TestCase):
    def fixture(self, root):
        directory = root / "artist-results-continuation"
        directory.mkdir()
        original = {"profile_id": "1", "cm_artist": "2", "artist_name": "Example", "group": "review",
                    "candidates_checked": [{"url": "https://www.instagram.com/good/", "status": "ok"},
                                           {"url": "https://www.instagram.com/other/", "status": "failed"}]}
        save_new(directory / "1.json", original)
        row = {**original, "candidates_checked": original["candidates_checked"][:1],
               "state": "VERIFIED", "instagram_url": "https://www.instagram.com/good/", "proof": ["frozen"],
               "adjudication": {"parent_decision_sha256": file_sha(directory / "1.json")}}
        return row

    def test_all_captures_restored_without_changing_decision_or_raw_row(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            row = self.fixture(root)
            result = complete_audit_row(root, "1.json", row)
            self.assertEqual(len(result["candidates_checked"]), 2)
            self.assertEqual(len(result["decision_candidates_checked"]), 1)
            self.assertEqual(len(row["candidates_checked"]), 1)
            self.assertEqual(result["state"], row["state"])
            self.assertEqual(result["proof"], row["proof"])
            self.assertEqual(result["instagram_url"], row["instagram_url"])
            self.assertFalse(result["decision_changed_by_evidence_join"])

    def test_changed_capture_metadata_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            row = self.fixture(root)
            row["candidates_checked"] = [{"url": "https://www.instagram.com/good/", "status": "changed"}]
            with self.assertRaises(ValueError):
                complete_audit_row(root, "1.json", row)

    def test_cross_artist_audit_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            row = self.fixture(root)
            row["cm_artist"] = "3"
            with self.assertRaises(ValueError):
                complete_audit_row(root, "1.json", row)


if __name__ == "__main__":
    unittest.main()
