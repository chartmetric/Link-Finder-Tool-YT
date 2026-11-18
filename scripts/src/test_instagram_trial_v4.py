import copy
import unittest

from instagram_trial_v4_rules import assess
from instagram_trial_v4_sources import explicit_text_links, is_hub, profile_links

SPOTIFY = "https://open.spotify.com/artist/4bAZXKyvEmDRxQCtcFkfGk"
OTHER = "https://open.spotify.com/artist/6OZoKIupckhfTgfa0WmKXb"
IG = "https://www.instagram.com/exampleartist/"


def fixture():
    artist = {"anchor_inventory_complete": True, "anchors": [
        {"anchor_id": "account:1", "url": SPOTIFY, "catalog_owned": True, "platform": "spotify"}]}
    source = {"anchor_id": "account:1", "url": SPOTIFY, "returned_url": SPOTIFY,
              "status": "ok", "identity_bound": True, "links": [], "receipt_id": "anchor",
              "capture_sha256": "a" * 64, "observed_at": "2026-11-18T00:00:00Z",
              "context_fields": ["profile.externalLinks"], "negative_complete": True,
              "website_declarations": [], "hub_links": []}
    candidate = {"url": IG, "status": "ok", "identity_bound": True, "links": [],
                 "receipt_id": "candidate", "capture_sha256": "b" * 64,
                 "observed_at": "2026-11-18T00:00:00Z", "followups_complete": True,
                 "negative_complete": True}
    progress = dict(searches_complete=True, anchor_followups_complete=True, all_candidates_captured=True)
    return artist, source, candidate, progress


class ProofFirstRules(unittest.TestCase):
    def test_outbound_proof_wins_over_every_incomplete_flag(self):
        artist, source, candidate, progress = fixture()
        source["links"] = [IG]
        source["negative_complete"] = False
        artist["anchor_inventory_complete"] = False
        candidate["status"] = "failed"
        progress = dict.fromkeys(progress, False)
        result = assess(artist, [source], [candidate], progress)
        self.assertEqual(result["state"], "VERIFIED")
        self.assertTrue(result["unfinished_checks"])
        self.assertFalse(result["unfinished_checks_blocking"])

    def test_backlink_proof_wins_over_unavailable_anchor(self):
        artist, source, candidate, progress = fixture()
        source["status"] = "failed"
        candidate["links"] = [SPOTIFY]
        self.assertEqual(assess(artist, [source], [candidate], progress)["state"], "VERIFIED")

    def test_actual_conflicting_targets_still_manual(self):
        artist, source, candidate, progress = fixture()
        source["links"] = [IG, "https://instagram.com/anotheraccount"]
        progress["searches_complete"] = False
        self.assertEqual(assess(artist, [source], [candidate], progress)["state"], "MANUAL_REVIEW")

    def test_name_only_is_not_proof(self):
        artist, source, candidate, progress = fixture()
        candidate.update(full_name="Example Artist", confidence=100, biography="The official artist")
        self.assertEqual(assess(artist, [source], [candidate], progress)["state"], "NOT_FOUND")

    def test_no_proof_and_missing_work_is_unfinished(self):
        artist, source, candidate, progress = fixture()
        candidate["followups_complete"] = False
        self.assertEqual(assess(artist, [source], [candidate], progress)["state"], "UNFINISHED")

    def test_declared_website_shared_with_ig_is_qualified(self):
        artist, source, candidate, progress = fixture()
        source["website_declarations"] = ["https://artist.example/tour"]
        candidate["links"] = ["https://artist.example/tour"]
        progress["anchor_followups_complete"] = False
        result = assess(artist, [source], [candidate], progress)
        self.assertEqual(result["state"], "VERIFIED")
        self.assertEqual(result["proof"][0]["reference_provenance"][0]["receipt_id"], "anchor")

    def test_arbitrary_website_links_are_not_known_references(self):
        artist, source, candidate, progress = fixture()
        source["links"] = ["https://tickets.example/shared"]
        candidate["links"] = source["links"]
        self.assertEqual(assess(artist, [source], [candidate], progress)["state"], "NOT_FOUND")

    def test_other_artist_spotify_is_not_global_conflict(self):
        artist, source, candidate, progress = fixture()
        source["links"] = [IG]
        unrelated = copy.deepcopy(candidate)
        unrelated.update(url="https://www.instagram.com/notthisartist/", links=[OTHER])
        self.assertEqual(assess(artist, [source], [candidate, unrelated], progress)["state"], "VERIFIED")

    def test_contradiction_on_supported_account_is_manual(self):
        artist, source, candidate, progress = fixture()
        source["links"] = [IG]
        candidate["links"] = [OTHER]
        self.assertEqual(assess(artist, [source], [candidate], progress)["state"], "MANUAL_REVIEW")

    def test_exact_catalog_social_handle_is_proof(self):
        artist, source, candidate, progress = fixture()
        artist["anchors"].append({"anchor_id": "account:2", "url": "https://tiktok.com/@exampleartist",
                                  "catalog_owned": True, "platform": "tiktok"})
        self.assertEqual(assess(artist, [source], [candidate], progress)["state"], "VERIFIED")

    def test_failed_unbound_page_cannot_create_proof(self):
        artist, source, candidate, progress = fixture()
        source.update(identity_bound=False, links=[IG])
        self.assertEqual(assess(artist, [source], [candidate], progress)["state"], "UNFINISHED")

    def test_unowned_candidate_hub_cannot_be_trusted_as_anchor(self):
        artist, source, candidate, progress = fixture()
        hub = {**source, "anchor_id": "candidate-hub:1", "url": "https://linktr.ee/noise",
               "links": [IG], "parent_receipt_id": "candidate", "receipt_id": "hub"}
        self.assertEqual(assess(artist, [source, hub], [candidate], progress)["state"], "UNFINISHED")


class SourceFields(unittest.TestCase):
    def test_explicit_instagram_label_is_link_not_name_match(self):
        self.assertIn(IG, explicit_text_links("Follow us!\nInstagram: @exampleartist\nThank you"))
        self.assertEqual(explicit_text_links("Example Artist @exampleartist"), [])
        self.assertEqual(explicit_text_links("My friend's Instagram: @exampleartist"), [])

    def test_www_and_artist_uri_are_explicit_links(self):
        self.assertIn("https://artist.example", explicit_text_links("Tour: www.artist.example"))
        self.assertIn(SPOTIFY, explicit_text_links("spotify:artist:4bAZXKyvEmDRxQCtcFkfGk"))

    def test_spotify_biography_links_not_related_content(self):
        data = {"success": True, "__typename": "Artist",
                "uri": "spotify:artist:4bAZXKyvEmDRxQCtcFkfGk", "id": SPOTIFY.split("/")[-1],
                "profile": {"externalLinks": [], "biography": {"text": "Instagram: @exampleartist"}},
                "relatedContent": {"biography": "Instagram: @unrelated"}}
        row = profile_links("spotify/artist", SPOTIFY, {"http_status": 200, "data": data})
        self.assertEqual(row["links"], [IG])

    def test_declared_tiktok_site_keeps_profile_binding(self):
        packet = {"http_status": 200, "data": {"success": True, "user": {
            "uniqueId": "exampleartist", "signature": "", "bioLink": {"link": "https://artist.example"}}}}
        row = profile_links("tiktok/profile", "https://tiktok.com/@exampleartist", packet)
        self.assertEqual(row["website_declarations"], ["https://artist.example"])
        packet["data"]["user"]["uniqueId"] = "notthisartist"
        with self.assertRaises(ValueError):
            profile_links("tiktok/profile", "https://tiktok.com/@exampleartist", packet)

    def test_new_unfollowed_hubs_are_recognized(self):
        self.assertTrue(is_hub("https://link.me/exampleartist"))
        self.assertTrue(is_hub("https://label.lnk.to/release"))
        self.assertFalse(is_hub("https://notlink.me.example/profile"))


if __name__ == "__main__":
    unittest.main()
