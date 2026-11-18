import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from instagram_trial_transport import AdmissionError
from instagram_trial_v4_transport import Transport


class Response:
    def __init__(self, status, data):
        self.status, self.raw = status, json.dumps(data).encode()

    def read(self, bound):
        return self.raw[:bound]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class BudgetFence(unittest.TestCase):
    def setup_transport(self, root):
        t = Transport(root, {"run_id": "fixture", "max_paid_requests": 4000}, enabled=False)
        t.enabled = True
        t.keys = {"sc": "fixture-only", "serper": "fixture-only"}
        return t

    def test_known_charge_settles_once_and_shared_key_is_not_replayed(self):
        with tempfile.TemporaryDirectory() as root:
            t = self.setup_transport(root)
            with patch("instagram_trial_transport.build_opener") as builder:
                builder.return_value.open.return_value = Response(200, {"success": True, "credits_charged": 1})
                first = t.paid("instagram/profile", {"handle": "fixture"})
                second = t.paid("instagram/profile", {"handle": "fixture"})
                self.assertEqual(first, second)
                self.assertEqual(builder.return_value.open.call_count, 1)
            self.assertEqual(t.request_count, 1)
            self.assertEqual(t.liability_microusd, 4000)
            events = [json.loads(s) for s in (Path(root) / "admissions.jsonl").read_text().splitlines()]
            self.assertEqual([e["event"] for e in events], ["reserved", "acknowledged", "settled"])
            self.assertEqual(events[0]["reserved_microusd"], 40000)

    def test_unknown_failed_charge_keeps_full_reservation_and_is_not_retried(self):
        with tempfile.TemporaryDirectory() as root:
            t = self.setup_transport(root)
            with patch("instagram_trial_transport.build_opener") as builder:
                builder.return_value.open.return_value = Response(500, {"success": False})
                t.paid("spotify/artist", {"id": "fixture"})
                t.paid("spotify/artist", {"id": "fixture"})
                self.assertEqual(builder.return_value.open.call_count, 1)
            self.assertEqual(t.liability_microusd, 40000)

    def test_cap_blocks_dispatch_before_any_network_call(self):
        with tempfile.TemporaryDirectory() as root:
            t = self.setup_transport(root)
            t.liability_microusd = 19_980_000
            with patch("instagram_trial_transport.build_opener") as builder:
                with self.assertRaises(AdmissionError):
                    t.paid("instagram/profile", {"handle": "fixture"})
                builder.assert_not_called()
            self.assertEqual(t.request_count, 0)

    def test_zero_credit_acknowledgment_does_not_spend_the_reservation(self):
        with tempfile.TemporaryDirectory() as root:
            t = self.setup_transport(root)
            with patch("instagram_trial_transport.build_opener") as builder:
                builder.return_value.open.return_value = Response(200, {"success": True, "credits_charged": 0})
                t.paid("instagram/profile", {"handle": "fixture"})
            self.assertEqual(t.liability_microusd, 0)

    def test_excessive_charge_halts_without_releasing_uncertain_liability(self):
        with tempfile.TemporaryDirectory() as root:
            t = self.setup_transport(root)
            with patch("instagram_trial_transport.build_opener") as builder:
                builder.return_value.open.return_value = Response(200, {"success": True, "credits_charged": 11})
                with self.assertRaises(AdmissionError):
                    t.paid("instagram/profile", {"handle": "fixture"})
            self.assertTrue(t.halted.is_set())
            self.assertEqual(t.liability_microusd, 40000)

    def test_whole_collector_uses_saved_receipts_and_new_proof_rules(self):
        from run_instagram_trial_v4 import Collector
        spotify_id = "4bAZXKyvEmDRxQCtcFkfGk"
        instagram = "https://www.instagram.com/exampleartist/"
        artist = {
            "profile_id": "1", "cm_artist": "2", "artist_name": "Fixture Artist",
            "tier": 2, "group": "review", "anchor_inventory_complete": True,
            "anchors": [{"anchor_id": "account:1", "platform": "spotify", "catalog_owned": True,
                         "url": "https://open.spotify.com/artist/" + spotify_id}],
        }

        def respond(request, **kwargs):
            if "serper.dev" in request.full_url:
                return Response(200, {"organic": []})
            if "/spotify/artist" in request.full_url:
                return Response(200, {
                    "success": True, "credits_charged": 1, "__typename": "Artist",
                    "id": spotify_id, "uri": "spotify:artist:" + spotify_id,
                    "profile": {"externalLinks": [], "biography": {"text": "Instagram: @exampleartist"}}})
            return Response(200, {"success": True, "credits_charged": 1, "data": {"user": {
                "username": "exampleartist", "external_url": None, "bio_links": [], "biography": ""}}})

        with tempfile.TemporaryDirectory() as root:
            transport = self.setup_transport(root)
            collector = Collector(Path(root), transport, {"candidate_capture_bound": 50, "anchor_followup_bound": 10})
            with patch("instagram_trial_transport.build_opener") as builder:
                builder.return_value.open.side_effect = respond
                row = collector.collect_artist(artist)
            self.assertEqual(row["state"], "VERIFIED")
            self.assertEqual(row["instagram_url"], instagram)
            self.assertEqual(row["rules_version"], "instagram-explicit-proof-first-v4")
            self.assertEqual(transport.request_count, 4)


if __name__ == "__main__":
    unittest.main()
