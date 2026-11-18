import copy
import unittest

from instagram_trial_v5_rules import assess
from instagram_trial_v5_scope import scope_of_page
from test_instagram_trial_v4 import fixture, SPOTIFY, IG


def source_fixture():
    artist, source, candidate, progress = fixture()
    artist["artist_name"] = "Example Artist"
    source["ownership_scope"] = {"status": "artist_specific"}
    candidate.update(direct_links=[], direct_hub_links=[], hub_checks=[],
                     ownership_scope={"status": "unconfirmed"})
    return artist, source, candidate, progress


class SingleArtistGate(unittest.TestCase):
    def test_label_forward_link_never_proves(self):
        a, s, c, p = source_fixture()
        s["ownership_scope"]["status"] = "excluded_multi_artist"
        s["links"] = [IG]
        self.assertNotEqual(assess(a, [s], [c], p)["state"], "VERIFIED")

    def test_label_backlink_never_proves(self):
        a, s, c, p = source_fixture()
        s["ownership_scope"]["status"] = "excluded_multi_artist"
        c["direct_links"] = [SPOTIFY]
        self.assertNotEqual(assess(a, [s], [c], p)["state"], "VERIFIED")

    def test_valid_proof_wins_over_other_label_and_failed_work(self):
        a, s, c, p = source_fixture()
        s["links"] = [IG]
        label = copy.deepcopy(s)
        label.update(anchor_id="account:label", url="https://youtube.com/@publisher",
                     returned_url="https://youtube.com/@publisher",
                     receipt_id="publisher", ownership_scope={"status": "excluded_multi_artist"})
        a["anchors"].append({"anchor_id": label["anchor_id"], "url": label["url"], "catalog_owned": True})
        p = dict.fromkeys(p, False)
        self.assertEqual(assess(a, [s, label], [c], p)["state"], "VERIFIED")

    def test_publisher_website_cannot_leak_as_declared_reference(self):
        a, s, c, p = source_fixture()
        site = "https://publisher.example/"
        s["website_declarations"] = [site]
        c["direct_links"] = [site]
        self.assertNotEqual(assess(a, [s], [c], p, publisher_hosts={"publisher.example"})["state"], "VERIFIED")

    def test_publisher_instagram_cannot_be_selected_even_from_spotify(self):
        a, s, c, p = source_fixture()
        s["links"] = [IG]
        c["ownership_scope"]["status"] = "excluded_multi_artist"
        self.assertNotEqual(assess(a, [s], [c], p)["state"], "VERIFIED")

    def test_flattened_linktree_backlink_is_not_reused(self):
        a, s, c, p = source_fixture()
        url = "https://linktr.ee/publisher"
        hub = copy.deepcopy(s)
        hub.update(url=url, returned_url=url, links=[SPOTIFY], ownership_scope={"status": "excluded_multi_artist"})
        c.update(links=[url, SPOTIFY], direct_links=[url], direct_hub_links=[url], hub_checks=[hub])
        result = assess(a, [s], [c], p)
        self.assertNotEqual(result["state"], "VERIFIED")
        self.assertIn(SPOTIFY, result["candidates_checked"][0]["links"])
        self.assertNotIn(SPOTIFY, result["decision_candidates"][0]["links"])

    def test_unknown_bio_page_remains_incomplete(self):
        a, s, c, p = source_fixture()
        url = "https://linktr.ee/unknown"
        c.update(direct_links=[url], direct_hub_links=[url])
        self.assertEqual(assess(a, [s], [c], p)["state"], "UNFINISHED")

    def test_single_artist_bio_page_backlink_works(self):
        a, s, c, p = source_fixture()
        url = "https://linktr.ee/artist"
        hub = copy.deepcopy(s)
        hub.update(url=url, returned_url=url, links=[SPOTIFY])
        c.update(direct_links=[url], direct_hub_links=[url], hub_checks=[hub])
        self.assertEqual(assess(a, [s], [c], p)["state"], "VERIFIED")

    def test_failed_capture_does_not_remove_known_spotify_backlink(self):
        a, s, c, p = source_fixture()
        s.update(status="failed", identity_bound=False, ownership_scope={"status": "unconfirmed"})
        c["direct_links"] = [SPOTIFY]
        self.assertEqual(assess(a, [s], [c], p)["state"], "VERIFIED")

    def test_shared_catalog_reference_is_not_proof(self):
        from instagram_proof_trial import identity
        a, s, c, p = source_fixture()
        s["links"] = [IG]
        self.assertNotEqual(assess(a, [s], [c], p, {identity(SPOTIFY)})["state"], "VERIFIED")

    def test_blocked_parent_cannot_launder_good_child(self):
        a, s, c, p = source_fixture()
        s.update(ownership_scope={"status": "excluded_multi_artist"},
                 website_declarations=["https://artist.example"])
        child = copy.deepcopy(s)
        child.update(anchor_id="followup:child", url="https://artist.example",
                     returned_url="https://artist.example",
                     parent_receipt_id=s["receipt_id"], receipt_id="child",
                     links=[IG], website_declarations=[], ownership_scope={"status": "artist_specific"})
        self.assertNotEqual(assess(a, [s, child], [c], p)["state"], "VERIFIED")


class OwnerScope(unittest.TestCase):
    def classify(self, kind, data, name="Example Artist", links=None):
        return scope_of_page({"kind": kind, "data": data},
                             {"links": links or []}, {"artist_name": name, "anchors": [{"url": SPOTIFY}]})

    def test_label_distributor_aggregator_titles(self):
        for title in ("Example Record Label", "Example Label Group", "Music Distributor",
                      "Music Aggregator", "Various Artists"):
            r = self.classify("youtube/channel", {"name": title, "description": ""})
            self.assertEqual(r["status"], "excluded_multi_artist", title)

    def test_roster_is_multi_artist(self):
        r = self.classify("linktree", {"username": "collective", "description": "Our artists and releases"})
        self.assertEqual(r["status"], "excluded_multi_artist")

    def test_abbreviated_label_name_with_artist_roster(self):
        r = self.classify("youtube/channel", {"name": "ABC", "description":
            "Home of everything Example Label Group.\nOur artist roster includes: Artist A, Artist B."})
        self.assertEqual(r["status"], "excluded_multi_artist")

    def test_multiple_artist_destinations_are_multi_artist(self):
        r = self.classify("linktree", {"username": "x", "links": [
            {"url": SPOTIFY}, {"url": "https://open.spotify.com/artist/6OZoKIupckhfTgfa0WmKXb"}]})
        self.assertEqual(r["status"], "excluded_multi_artist")

    def test_artist_mentioning_label_is_not_a_publisher(self):
        r = self.classify("spotify/artist", {"profile": {
            "name": "Example Artist", "biography": {"text": "A singer signed to an independent record label."}}})
        self.assertEqual(r["status"], "artist_specific")

    def test_artist_band_is_one_artist_entity(self):
        r = self.classify("youtube/channel", {"name": "Example Band", "description": "We are a band."})
        self.assertEqual(r["status"], "artist_specific")

    def test_badge_and_name_alone_do_not_establish_scope(self):
        r = self.classify("youtube/channel", {"name": "Example Artist", "isVerified": True})
        self.assertEqual(r["status"], "unconfirmed")

    def test_related_artist_fields_do_not_define_owner_scope(self):
        r = self.classify("spotify/artist", {"profile": {"name": "Example Artist"},
                                          "relatedContent": {"name": "Record Label", "description": "Our artists"}})
        self.assertEqual(r["status"], "artist_specific")

    def test_linktree_name_without_independent_identity_is_insufficient(self):
        r = self.classify("linktree", {"username": "Example Artist", "description": "Music"})
        self.assertEqual(r["status"], "unconfirmed")

    def test_linktree_exact_artist_destination_plus_scope(self):
        r = self.classify("linktree", {"username": "Example Artist", "links": [{"url": SPOTIFY}]})
        self.assertEqual(r["status"], "artist_specific")


if __name__ == "__main__":
    unittest.main()
