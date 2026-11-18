"""Offline tests. No provider or database traffic."""
import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from instagram_trial_extract import (
    normalize_link, provider_request, sc_profile, website_links,
)
from instagram_trial_transport import (
    AdmissionError, TrialTransport, file_sha, output_paths, public_address,
)
from run_instagram_locked_trial import assess, search_candidates

SPOTIFY = "https://open.spotify.com/artist/0123456789ABCDEFGHIJKL"
IG = "https://www.instagram.com/example/"


def fixture():
    a = {"profile_id": "1", "cm_artist": "2", "artist_name": "Example",
         "anchor_inventory_complete": True, "anchors": [
             {"anchor_id": "s", "url": SPOTIFY, "platform": "spotify"}]}
    r = {"anchor_id": "s", "url": SPOTIFY, "status": "ok", "identity_bound": True,
         "links": [], "negative_complete": True, "receipt_id": "r",
         "context_fields": ["profile.externalLinks"], "observed_at": "2026-11-18T00:00:00Z",
         "capture_sha256": "f" * 64}
    c = {"url": IG, "status": "ok", "identity_bound": True, "links": [],
         "receipt_id": "c", "observed_at": "2026-11-18T00:00:00Z",
         "capture_sha256": "e" * 64, "followups_complete": True}
    p = {"searches_complete": True, "anchor_followups_complete": True, "all_candidates_captured": True}
    return a, r, c, p


class DecisionTests(unittest.TestCase):
    def test_anchor_proof(self):
        a, r, c, p = fixture()
        r["links"] = [IG]
        self.assertEqual(assess(a, [r], [c], p)["state"], "VERIFIED")

    def test_backlink_proof(self):
        a, r, c, p = fixture()
        c["links"] = [SPOTIFY]
        self.assertEqual(assess(a, [r], [c], p)["state"], "VERIFIED")

    def test_names_scores_badges_ignored(self):
        a, r, c, p = fixture()
        c.update(full_name="Example", confidence=100, verified=True)
        self.assertEqual(assess(a, [r], [c], p)["state"], "NOT_FOUND")

    def test_other_spotify_conflict_not_accepted(self):
        a, r, c, p = fixture()
        c["links"] = [SPOTIFY, SPOTIFY[:-1] + "M"]
        self.assertEqual(assess(a, [r], [c], p)["state"], "MANUAL_REVIEW")

    def test_two_anchors_conflict(self):
        a, r, c, p = fixture()
        r["links"] = [IG, "https://instagram.com/other/"]
        self.assertEqual(assess(a, [r], [c], p)["state"], "MANUAL_REVIEW")

    def test_anchor_and_candidate_conflict(self):
        a, r, c, p = fixture()
        r["links"] = ["https://instagram.com/other/"]
        c["links"] = [SPOTIFY]
        self.assertEqual(assess(a, [r], [c], p)["state"], "MANUAL_REVIEW")

    def test_missing_other_anchor_cannot_accept(self):
        a, r, c, p = fixture()
        a["anchors"].append({"anchor_id": "second", "url": "https://example.com", "platform": "website"})
        r["links"] = [IG]
        self.assertEqual(assess(a, [r], [c], p)["state"], "UNFINISHED")

    def test_search_mandatory_even_with_anchor(self):
        a, r, c, p = fixture()
        r["links"] = [IG]
        p["searches_complete"] = False
        self.assertEqual(assess(a, [r], [c], p)["state"], "UNFINISHED")

    def test_every_incomplete_protocol_flag_is_not_notfound(self):
        for flag in ("searches_complete", "anchor_followups_complete", "all_candidates_captured"):
            a, r, c, p = fixture()
            p[flag] = False
            self.assertEqual(assess(a, [r], [c], p)["state"], "UNFINISHED")

    def test_failed_candidate_not_notfound(self):
        a, r, c, p = fixture()
        c["status"] = "failed"
        self.assertEqual(assess(a, [r], [c], p)["state"], "UNFINISHED")

    def test_failed_anchor_not_notfound(self):
        a, r, c, p = fixture()
        r["status"] = "failed"
        self.assertEqual(assess(a, [r], [c], p)["state"], "UNFINISHED")

    def test_incomplete_hub_not_notfound(self):
        a, r, c, p = fixture()
        c["followups_complete"] = False
        self.assertEqual(assess(a, [r], [c], p)["state"], "UNFINISHED")

    def test_known_twitter_handle_only(self):
        a, r, c, p = fixture()
        a["anchors"].append({"anchor_id": "t", "url": "https://x.com/example", "platform": "twitter"})
        t = {**r, "anchor_id": "t", "url": "https://x.com/example"}
        self.assertEqual(assess(a, [r, t], [c], p)["state"], "VERIFIED")

    def test_youtube_name_handle_alone_not_proof(self):
        a, r, c, p = fixture()
        a["anchors"] = [{"anchor_id": "s", "url": "https://youtube.com/@example", "platform": "youtube"}]
        self.assertEqual(assess(a, [r], [c], p)["state"], "NOT_FOUND")

    def test_no_anchors_no_candidates_completed_search_notfound(self):
        a, r, c, p = fixture()
        a["anchors"] = []
        self.assertEqual(assess(a, [], [], p)["state"], "NOT_FOUND")


class ExtractTests(unittest.TestCase):
    def packet(self, data):
        return {"http_status": 200, "data": data}

    def test_spotify_only_own_external_links_not_related_artists(self):
        d = {"__typename": "Artist", "id": SPOTIFY.rsplit("/", 1)[-1],
             "uri": "spotify:artist:" + SPOTIFY.rsplit("/", 1)[-1],
             "profile": {"externalLinks": [{"name": "Instagram", "url": IG}]},
             "relatedContent": {"instagram": "https://instagram.com/wrong"}}
        out = sc_profile("spotify/artist", SPOTIFY, self.packet(d))
        self.assertEqual(out["links"], ["https://instagram.com/example"])
        d["id"] = "wrong"
        with self.assertRaises(ValueError):
            sc_profile("spotify/artist", SPOTIFY, self.packet(d))

    def test_spotify_missing_external_fields_is_incomplete(self):
        d = {"__typename": "Artist", "id": SPOTIFY.rsplit("/", 1)[-1],
             "uri": "spotify:artist:" + SPOTIFY.rsplit("/", 1)[-1], "profile": {}}
        with self.assertRaises(ValueError):
            sc_profile("spotify/artist", SPOTIFY, self.packet(d))

    def test_instagram_missing_fields_not_empty(self):
        for d in ({"username": "example"}, {"username": "example", "external_url": None}):
            with self.assertRaises(ValueError):
                sc_profile("instagram/profile", IG, self.packet({"data": {"user": d}}))

    def test_instagram_own_identity_required(self):
        d = {"username": "wrong", "external_url": SPOTIFY, "bio_links": []}
        with self.assertRaises(ValueError):
            sc_profile("instagram/profile", IG, self.packet({"data": {"user": d}}))

    def test_instagram_direct_empty_fields_valid(self):
        d = {"username": "example", "external_url": None, "bio_links": []}
        out = sc_profile("instagram/profile", IG, self.packet({"data": {"user": d}}))
        self.assertEqual(out["links"], [])

    def test_unwrap_only_known_redirects(self):
        self.assertEqual(normalize_link("https://l.instagram.com/?u=https%3A%2F%2Fexample.com"), "https://example.com")
        self.assertEqual(normalize_link("https://bad.example/?u=https://example.com"),
                         "https://bad.example?u=https%3A%2F%2Fexample.com")

    def test_linktree_bound_and_explicit_links(self):
        d = {"username": "example", "links": [{"url": SPOTIFY}], "instagram": IG}
        out = sc_profile("linktree", "https://linktr.ee/example", self.packet(d))
        self.assertIn("https://instagram.com/example", out["links"])
        with self.assertRaises(ValueError):
            sc_profile("linktree", "https://linktr.ee/other", self.packet(d))

    def test_search_profile_urls_only_and_dedup(self):
        packet = {"http_status": 200, "request_id": "q", "data": {"organic": [
            {"link": IG}, {"link": IG}, {"link": "https://instagram.com/p/abc"},
            {"link": "https://notinstagram.com/example"}]}}
        rows, ok = search_candidates([packet])
        self.assertTrue(ok)
        self.assertEqual([r["url"] for r in rows], [IG])

    def test_failed_or_malformed_search_not_empty(self):
        for packet in ({"http_status": 500}, {"http_status": 200, "data": {}}):
            self.assertFalse(search_candidates([packet])[1])

    def test_public_challenge_not_empty_page(self):
        with self.assertRaises(ValueError):
            website_links({"status": 200, "content_type": "text/html",
                           "body": "Just a moment" * 20, "final_url": "https://example.com"})

    def test_provider_routes_fixed(self):
        self.assertEqual(provider_request(SPOTIFY), ("spotify/artist", {"id": SPOTIFY.rsplit("/", 1)[-1]}))
        self.assertIsNone(provider_request("https://artist.example"))


class TransportTests(unittest.TestCase):
    def transport(self, path):
        t = TrialTransport.__new__(TrialTransport)
        t.enabled, t.lock, t.halted = True, threading.RLock(), threading.Event()
        t.ledger, t.receipts = path / "admissions.jsonl", path
        t.scope, t.memory, t.keys = {"run_id": "test"}, {}, {"serper": "fixture-not-a-key"}
        t.reserved_cents, t.request_count = 0, 0
        return t

    def test_budget_admission_before_dispatch_and_never_reclaimed(self):
        with tempfile.TemporaryDirectory() as d:
            t = self.transport(Path(d))
            t.reserved_cents, t.request_count = 5998, 2999
            t.admit("last", "serper", {})
            self.assertEqual(t.reserved_cents, 6000)
            with self.assertRaises(AdmissionError):
                t.admit("beyond", "serper", {})
            self.assertEqual(len(t.ledger.read_text().splitlines()), 1)

    def test_uncertain_response_fenced_not_retried(self):
        with tempfile.TemporaryDirectory() as d:
            t = self.transport(Path(d))
            with patch("instagram_trial_transport.build_opener") as opener:
                opener.return_value.open.side_effect = TimeoutError()
                with self.assertRaises(AdmissionError):
                    t.paid("serper", {"q": "fixture", "num": 10})
                with self.assertRaises(AdmissionError):
                    t.paid("serper", {"q": "fixture", "num": 10})
                self.assertEqual(opener.return_value.open.call_count, 1)
            self.assertEqual(t.request_count, 1)
            self.assertTrue(t.halted.is_set())
            self.assertTrue(any(p.name != "admissions.jsonl" for p in Path(d).glob("*.json")))

    def test_unsafe_endpoint_rejected_before_admission(self):
        with tempfile.TemporaryDirectory() as d:
            t = self.transport(Path(d))
            with self.assertRaises(AdmissionError):
                t.paid("../../internal", {})
            self.assertEqual(t.request_count, 0)

    def test_failed_500_is_saved_held_and_never_dispatched_again(self):
        class Response:
            status = 500

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def read(self, limit):
                return b'{"message":"Internal Server Error"}'

        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            t = self.transport(root)
            t.keys["sc"] = "fixture-not-a-key"
            with patch("instagram_trial_transport.build_opener") as opener:
                opener.return_value.open.return_value = Response()
                packet = t.paid("spotify/artist", {"id": "0123456789ABCDEFGHIJKL"})
                self.assertEqual(packet["http_status"], 500)
                self.assertFalse(t.halted.is_set())
                self.assertEqual(t.reserved_cents, 2)
            reloaded = self.transport(root)
            reloaded.load_saved_admissions()
            with patch("instagram_trial_transport.build_opener") as opener:
                cached = reloaded.paid("spotify/artist", {"id": "0123456789ABCDEFGHIJKL"})
                opener.assert_not_called()
            self.assertEqual(cached["http_status"], 500)
            self.assertEqual(reloaded.request_count, 1)
            self.assertEqual(reloaded.reserved_cents, 2)

    def test_changed_saved_provider_packet_refused_before_continuation(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            t = self.transport(root)
            key = __import__("instagram_proof_trial").digest({"kind": "serper", "params": {"q": "x"}})
            path = root / (key + ".json")
            path.write_text("{}")
            t.ledger.write_text(json.dumps({"event": "reserved", "request_id": key, "kind": "serper",
                                           "payload": {"q": "x"}, "reserved_cents": 2}) + "\n" +
                                json.dumps({"event": "acknowledged", "request_id": key,
                                            "receipt_sha256": file_sha(path), "charge_bound_confirmed": True}) + "\n")
            path.write_text('{"changed":true}')
            with self.assertRaises(AdmissionError):
                t.load_saved_admissions()

    def test_uncertain_old_request_is_a_nonreplayable_tombstone(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            t = self.transport(root)
            key = __import__("instagram_proof_trial").digest({"kind": "serper", "params": {"q": "x"}})
            t.ledger.write_text(json.dumps({"event": "reserved", "request_id": key, "kind": "serper",
                                           "payload": {"q": "x"}, "reserved_cents": 2}) + "\n")
            t.load_saved_admissions()
            with patch("instagram_trial_transport.build_opener") as opener:
                with self.assertRaises(AdmissionError):
                    t.paid("serper", {"q": "x"})
                opener.assert_not_called()
            self.assertEqual(t.reserved_cents, 2)

    def test_halted_outputs_cannot_be_published_as_finished(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "decisions-frozen.json").write_text('{"halted":true}')
            with self.assertRaises(ValueError):
                output_paths(root)

    def test_public_ip_fence(self):
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1",
                        "0.0.0.0", "224.0.0.1", "192.168.1.1", "192.0.2.1"):
            self.assertFalse(public_address(address))
        self.assertTrue(public_address("8.8.8.8"))


if __name__ == "__main__":
    unittest.main()
