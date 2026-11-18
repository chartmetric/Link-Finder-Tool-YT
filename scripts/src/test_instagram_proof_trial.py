"""Offline fixtures only. No catalog, provider or model access."""

import unittest
from datetime import datetime, timedelta, timezone

from instagram_proof_trial import decide, evaluate, identity, instagram_url
from prepare_instagram_proof_trial import choose_review

NOW = datetime(2026, 11, 18, 2, tzinfo=timezone.utc)
SPOTIFY = "https://open.spotify.com/artist/" + "A" * 22
OTHER_SPOTIFY = "https://open.spotify.com/artist/" + "B" * 22
IG = "https://www.instagram.com/actual_artist/"
OTHER_IG = "https://www.instagram.com/another_artist/"


def profile():
    return {"profile_id": "123", "cm_artist": "456", "artist_name": "Artist",
            "anchor_inventory_complete": True, "anchors": [{
                "anchor_id": "1", "platform": "spotify", "url": SPOTIFY, "catalog_owned": True}]}


def receipt(url=SPOTIFY, links=None, candidate=False):
    return {"profile_id": "123", "cm_artist": "456", "anchor_id": "1", "evidence_id": "fixture-only",
            "source_url": url, "returned_account_url": url, "links": [] if links is None else links,
            "status": "ok", "links_complete": True, "raw_capture_sha256": "a" * 64,
            "observed_at": NOW.isoformat(),
            "extraction_kind": "instagram_direct_bio_links" if candidate else "artist_profile_owned_links"}


def progress():
    return {"anchor_followups_complete": True, "searches_complete": True, "required_query_count": 2,
            "successful_query_count": 2, "all_discovered_candidates_disposed": True,
            "candidate_hub_followups_complete": True}


class ProofRules(unittest.TestCase):
    def decide(self, pages=None, candidates=None, p=None, state=None):
        return decide(p or profile(), [receipt()] if pages is None else pages,
                      candidates or [], state or progress(), now=NOW)

    def test_name_and_probability_never_verify(self):
        c = receipt(IG, candidate=True)
        c.update(display_name="Artist", confidence=100, jev_verdict="verified", is_verified=True)
        self.assertEqual(self.decide(candidates=[c])["state"], "NOT_FOUND")

    def test_anchor_link_verifies(self):
        r = self.decide(pages=[receipt(links=[IG])])
        self.assertEqual(r["state"], "VERIFIED")
        self.assertEqual(r["proof_edges"][0]["target_url"], IG)

    def test_check_other_anchors_even_after_success(self):
        p = profile()
        p["anchors"].append({"anchor_id": "2", "platform": "website",
                             "url": "https://artist.example", "catalog_owned": True})
        self.assertEqual(self.decide(p=p, pages=[receipt(links=[IG])])["state"], "UNFINISHED")

    def test_conflict_never_resolved_by_name(self):
        self.assertIn("MANUAL_REVIEW", self.decide(
            pages=[receipt(links=[IG, OTHER_IG])])["reason_codes"][0])

    def test_blocked_page_not_not_found(self):
        r = receipt()
        r["status"] = "blocked"
        self.assertEqual(self.decide(pages=[r])["state"], "UNFINISHED")

    def test_empty_text_is_not_complete_links(self):
        r = receipt()
        r["links_complete"] = False
        self.assertEqual(self.decide(pages=[r])["state"], "UNFINISHED")

    def test_unbound_source_rejected(self):
        r = receipt(links=[IG])
        r["returned_account_url"] = OTHER_SPOTIFY
        self.assertEqual(self.decide(pages=[r])["state"], "UNFINISHED")

    def test_wrong_artist_profile_id_rejected(self):
        r = receipt(links=[IG])
        r["profile_id"] = "999"
        self.assertEqual(self.decide(pages=[r])["state"], "UNFINISHED")

    def test_old_capture_held(self):
        r = receipt(links=[IG])
        r["observed_at"] = (NOW - timedelta(days=31)).isoformat()
        self.assertEqual(self.decide(pages=[r])["state"], "UNFINISHED")

    def test_no_timestamp_held(self):
        r = receipt(links=[IG])
        del r["observed_at"]
        self.assertEqual(self.decide(pages=[r])["state"], "UNFINISHED")

    def test_candidate_exact_spotify_backlink(self):
        r = self.decide(candidates=[receipt(IG, [SPOTIFY], candidate=True)])
        self.assertEqual(r["state"], "VERIFIED")

    def test_conflicting_spotify_even_with_match_is_held(self):
        r = self.decide(candidates=[receipt(IG, [SPOTIFY, OTHER_SPOTIFY], candidate=True)])
        self.assertEqual(r["state"], "UNFINISHED")

    def test_tracking_does_not_change_website_identity(self):
        self.assertEqual(identity("https://artist.example/?utm_source=instagram&fbclid=abc"),
                         identity("https://artist.example"))
        self.assertNotEqual(identity("https://artist.example/person/a"),
                            identity("https://artist.example/person/b"))

    def test_spotify_album_not_artist_identity(self):
        c = receipt(IG, [SPOTIFY.replace("/artist/", "/album/")], candidate=True)
        self.assertEqual(self.decide(candidates=[c])["state"], "NOT_FOUND")

    def test_failed_search_never_not_found(self):
        state = progress()
        state["successful_query_count"] = 1
        self.assertEqual(self.decide(state=state)["state"], "UNFINISHED")

    def test_no_candidates_after_complete_search_not_found(self):
        self.assertEqual(self.decide()["state"], "NOT_FOUND")

    def test_page_followup_cap_never_not_found(self):
        state = progress()
        state["anchor_followups_complete"] = False
        self.assertEqual(self.decide(state=state)["state"], "UNFINISHED")

    def test_candidate_cap_never_not_found(self):
        state = progress()
        state["all_discovered_candidates_disposed"] = False
        self.assertEqual(self.decide(state=state)["state"], "UNFINISHED")

    def test_candidate_hub_is_not_backlink(self):
        c = receipt(IG, ["https://linktr.ee/actual_artist"], candidate=True)
        self.assertEqual(self.decide(candidates=[c])["state"], "UNFINISHED")

    def test_multiple_candidates_with_proof_need_review(self):
        cs = [receipt(u, [SPOTIFY], candidate=True) for u in (IG, OTHER_IG)]
        self.assertEqual(self.decide(candidates=cs)["state"], "UNFINISHED")

    def test_exact_twitter_handle_allowed(self):
        p = profile()
        p["anchors"] = [{"anchor_id": "1", "url": "https://x.com/actual_artist", "catalog_owned": True}]
        r = self.decide(p=p, pages=[receipt("https://twitter.com/actual_artist")],
                        candidates=[receipt(IG, candidate=True)])
        self.assertEqual(r["state"], "VERIFIED")

    def test_youtube_handle_alone_not_allowed(self):
        p = profile()
        p["anchors"] = [{"anchor_id": "1", "url": "https://youtube.com/@actual_artist", "catalog_owned": True}]
        r = self.decide(p=p, pages=[receipt("https://youtube.com/@actual_artist")],
                        candidates=[receipt(IG, candidate=True)])
        self.assertEqual(r["state"], "NOT_FOUND")

    def test_instagram_aliases_and_lookalikes(self):
        self.assertEqual(instagram_url("https://instagram.com/Actual_Artist/?utm_source=x"), IG)
        self.assertIsNone(instagram_url("https://instagram.com.evil.example/actual_artist"))
        self.assertIsNone(instagram_url("https://instagram.com/p/actual_artist"))
        self.assertIsNone(instagram_url("https://instagram.com@evil.example/actual_artist"))

    def test_case_sensitive_spotify_id(self):
        self.assertNotEqual(identity(SPOTIFY), identity(SPOTIFY.lower()))

    def test_untrusted_catalog_association_is_not_owned_page(self):
        p = profile()
        p["anchors"][0]["catalog_owned"] = False
        self.assertEqual(self.decide(p=p, pages=[receipt(links=[IG])])["state"], "UNFINISHED")

    def test_backtest_denominators_include_unfinished(self):
        controls = [{"profile_id": str(i), "accepted_urls": [IG]} for i in range(200)]
        rows = [{"profile_id": str(i), "state": "UNFINISHED", "proof_edges": []} for i in range(200)]
        rows[0].update(state="VERIFIED", proof_edges=[{"target_url": IG}])
        rows[1]["state"] = "NOT_FOUND"
        r = evaluate(rows, controls)
        self.assertEqual(r["known_link_agreement"], 1)
        self.assertEqual(r["false_not_found_rate"], 1 / 200)
        self.assertEqual(r["unfinished_rate"], 198 / 200)

    def test_no_found_agreement_is_undefined_not_zero(self):
        controls = [{"profile_id": str(i), "accepted_urls": [IG]} for i in range(200)]
        rows = [{"profile_id": str(i), "state": "UNFINISHED", "proof_edges": []} for i in range(200)]
        self.assertIsNone(evaluate(rows, controls)["known_link_agreement"])

    def test_backtest_cannot_drop_missing_control(self):
        controls = [{"profile_id": str(i), "accepted_urls": [IG]} for i in range(200)]
        with self.assertRaises(ValueError):
            evaluate([], controls)

    def test_review_sample_reproducible(self):
        rows = [{"profile_id": str(i + 1), "decision": "review" if i < 31303 else "keep"}
                for i in range(48333)]
        a, b = choose_review(rows), choose_review(list(reversed(rows)))
        self.assertEqual(a, b)
        self.assertEqual(len({r["profile_id"] for r in a}), 200)
        self.assertTrue(all(r["decision"] == "review" for r in a))

    def test_changed_population_is_not_silently_sampled(self):
        with self.assertRaises(ValueError):
            choose_review([])


if __name__ == "__main__":
    unittest.main()
