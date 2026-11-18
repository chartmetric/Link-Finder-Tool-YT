"""Cheap offline checks for the saved-data export's joins and missing-value rules."""

import json
import tempfile
import unittest
from pathlib import Path

from instagram_saved_export_helpers import (
    ROOT, capture_fields, catalog_fields, handle, is_assessed_candidate, legacy_indexes, read_json,
    resolve_receipts,
)


class SavedInstagramExportTests(unittest.TestCase):
    def test_zero_followers_and_false_business_are_not_missing(self):
        candidate = {"url": "https://www.instagram.com/example/"}
        packet = {"status": 200, "data": {"success": True, "data": {"user": {
            "username": "example", "full_name": "Example", "biography": "",
            "is_business_account": False, "edge_followed_by": {"count": 0},
            "external_url": None, "bio_links": [],
        }}}}
        fields, gaps = capture_fields(packet, candidate)
        self.assertEqual(fields["capture_status"], "ok")
        self.assertIs(fields["scrapecreators_is_business"], False)
        self.assertEqual(fields["scrapecreators_followers"], 0)
        self.assertEqual(fields["scrapecreators_biography"], "")
        self.assertEqual(gaps, [])

    def test_missing_capture_is_not_successful_empty_capture(self):
        candidate = {"url": "https://www.instagram.com/example/"}
        missing, _ = capture_fields(None, candidate)
        empty, _ = capture_fields({"status": 200, "data": {"success": True}}, candidate)
        self.assertEqual(missing["capture_evidence_source"], "none")
        self.assertEqual(missing["capture_status"], "failed")
        self.assertEqual(empty["capture_evidence_source"], "raw_scrapecreators_receipt")
        self.assertEqual(empty["capture_status"], "empty")

    def test_usable_profile_and_provider_error_are_reported_separately(self):
        candidate = {"url": "https://www.instagram.com/example/"}
        packet = {"status": 200, "data": {"success": True, "error": "not_found",
                  "data": {"user": {"username": "example", "full_name": "Example"}}}}
        fields, gaps = capture_fields(packet, candidate)
        self.assertEqual(fields["capture_status"], "ok")
        self.assertTrue(fields["capture_provider_error_flag"])
        self.assertEqual(fields["capture_provider_error_code"], "not_found")
        self.assertIn("provider_error_flag_despite_success_and_returned_profile", gaps)

    def test_normalized_capture_is_not_reported_as_raw_receipt(self):
        candidate = {"url": "https://www.instagram.com/example/", "metadata": {
            "available": True, "candidate": {"displayName": "Example", "bio": "Music"}}}
        fields, gaps = capture_fields(None, candidate)
        self.assertEqual(fields["capture_status"], "ok")
        self.assertFalse(fields["raw_capture_receipt_available"])
        self.assertEqual(fields["capture_evidence_source"], "normalized_scrapecreators_profile_only")
        self.assertIn("raw_scrapecreators_receipt_not_found", gaps)

    def test_jsonl_preserves_unicode_line_separator_inside_json(self):
        with tempfile.TemporaryDirectory(prefix="instagram-export-test-", dir="generated-artifacts") as folder:
            root = Path(folder)
            execution = root / "execution"
            (execution / "metadata-responses").mkdir(parents=True)
            (execution / "model-responses").mkdir()
            (root / "approved-scope.json").write_text('{"targets":[]}')
            (execution / "metadata-responses" / "metadata-test.json").write_text("{}")
            record = {"profileId": "123", "key": "metadata-test", "request": {
                "kind": "scrapecreators_candidate", "body": {"url": "https://www.instagram.com/example/"},
                "note": "Biography with\u2028a Unicode separator"}}
            (execution / "admissions.jsonl").write_text(json.dumps(record, ensure_ascii=False) + "\n")
            index = legacy_indexes(folder)
            self.assertIn(("123", "example"), index["metadata"])

    def test_actual_sequential_and_parallel_archives_resolve(self):
        for profile_id in ("4657", "4155764"):
            result = read_json(ROOT / "artists" / (profile_id + ".json"))
            candidate = next(c for c in result["candidates"] if c.get("reviewSuggestion"))
            model, capture, request, state, _, _ = resolve_receipts(
                profile_id, candidate, str(ROOT), {})
            self.assertIsNotNone(model)
            self.assertIsNotNone(capture)
            self.assertEqual(request["state"], candidate["metadataActuallyUsed"])
            self.assertEqual(str(state["catalogAccountEvidence"]["cmArtist"]), str(result["cmArtist"]))

    def test_catalog_urls_come_from_reference_not_candidate_bio(self):
        state = {"knownProfileUrl": "https://app.chartmetric.com/artist/9", "candidates": [{
            "reference": {"url": "https://app.chartmetric.com/artist/9"},
            "candidate": {"bio": "https://open.spotify.com/artist/WRONG"},
        }], "catalogAccountEvidence": {"cmArtist": "9", "accounts": [
            {"platform": "spotify", "url": "https://open.spotify.com/artist/RIGHT"}]}}
        fields = catalog_fields(state, "9")
        self.assertEqual(json.loads(fields["catalog_spotify_artist_ids_json"]), ["RIGHT"])

    def test_handles_are_profile_urls_only(self):
        self.assertEqual(handle("https://www.instagram.com/Example/"), "example")
        self.assertIsNone(handle("https://www.instagram.com/p/123/"))
        self.assertIsNone(handle("https://example.com/example/"))

    def test_legacy_uninspected_hits_are_not_assessments(self):
        self.assertFalse(is_assessed_candidate({
            "url": "https://www.instagram.com/example/", "status": "uninspected",
            "reason": "not_inspected_within_approved_run"}))
        self.assertTrue(is_assessed_candidate({
            "url": "https://www.instagram.com/example/", "status": "unavailable",
            "metadata": {"available": False}}))


if __name__ == "__main__":
    unittest.main()
