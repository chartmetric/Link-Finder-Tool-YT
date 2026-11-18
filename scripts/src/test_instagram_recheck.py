import unittest
from urllib.parse import quote

from instagram_recheck_rules import normalize_name, recheck, url_identity

SPOTIFY = "A" * 22
OTHER_SPOTIFY = "B" * 22
CHANNEL = "UC" + "A" * 22


def artist(**changes):
    value = {
        "artist_name": "Ana 123", "selected_handle": "ana123",
        "scrapecreators_full_name": "Ana 123", "scrapecreators_biography": "",
        "scrapecreators_category": "Musician/band", "capture_status": "ok",
        "catalog_spotify_artist_ids_json": [SPOTIFY], "catalog_youtube_urls_json": [],
        "catalog_twitter_urls_json": [], "catalog_tiktok_urls_json": [],
        "catalog_accounts_used_json": [], "scrapecreators_external_urls_json": [],
        "scrapecreators_bio_link_urls_json": [], "scrapecreators_bio_link_page_urls_json": [],
    }
    value.update(changes)
    return value


class RecheckTests(unittest.TestCase):
    def test_normalization_preserves_digits_and_word_boundaries(self):
        self.assertEqual(normalize_name("The DJ Ána-123 Official Music"), "ana123")
        self.assertNotEqual(normalize_name("Ana123"), normalize_name("Ana"))
        self.assertEqual(normalize_name("Theodore"), "theodore")
        self.assertEqual(normalize_name("iamgroot"), "iamgroot")

    def test_never_transliterates_different_scripts(self):
        self.assertNotEqual(normalize_name("2000х"), normalize_name("2000x"))

    def test_empty_names_cannot_match(self):
        value = recheck(artist(artist_name="The Music Band", scrapecreators_full_name="Official"))
        self.assertEqual(value["decision"], "review")

    def test_display_name_exact_after_normalization(self):
        value = recheck(artist(scrapecreators_full_name="DJ Ána 123 Official"))
        self.assertEqual(value["decision"], "keep")
        self.assertIn("EXACT_NORMALIZED_DISPLAY_NAME", value["reason_codes"])

    def test_handle_match_also_requires_complete_display_name(self):
        good = recheck(artist(scrapecreators_full_name="Ana 123 | live performer"))
        bad = recheck(artist(artist_name="Ana", selected_handle="ana", scrapecreators_full_name="Anastasia"))
        self.assertEqual(good["decision"], "keep")
        self.assertEqual(bad["decision"], "review")

    def test_scores_do_not_influence_any_decision(self):
        low = artist(jev_same_identity_probability=0.01)
        high = artist(jev_same_identity_probability=0.99)
        self.assertEqual(recheck(low), recheck(high))
        self.assertEqual(recheck(artist(scrapecreators_full_name="Other person", jev_same_identity_probability=0.99))["decision"], "review")

    def test_exact_spotify_link_can_qualify_without_name_match(self):
        value = recheck(artist(scrapecreators_full_name="An alias",
                              scrapecreators_external_urls_json=["https://open.spotify.com/artist/" + SPOTIFY]))
        self.assertEqual(value["decision"], "keep")
        self.assertIn("EXACT_CATALOG_SPOTIFY_LINK", value["reason_codes"])

    def test_foreign_spotify_overrides_own_spotify_and_exact_name(self):
        value = recheck(artist(scrapecreators_external_urls_json=[
            "https://open.spotify.com/artist/" + SPOTIFY,
            "https://open.spotify.com/artist/" + OTHER_SPOTIFY]))
        self.assertEqual(value["decision"], "review")
        self.assertIn("CONFLICT_DIFFERENT_SPOTIFY_ARTIST", value["reason_codes"])

    def test_unknown_catalog_spotify_is_review_not_proven_mismatch(self):
        value = recheck(artist(catalog_spotify_artist_ids_json=[],
                              scrapecreators_biography="spotify:artist:" + SPOTIFY))
        self.assertEqual(value["decision"], "review")
        self.assertIn("REVIEW_SPOTIFY_ID_WITHOUT_CATALOG_REFERENCE", value["reason_codes"])
        self.assertNotIn("CONFLICT_DIFFERENT_SPOTIFY_ARTIST", value["reason_codes"])

    def test_track_playlist_and_lookalike_domains_are_not_artist_ids(self):
        for url in ("https://open.spotify.com/track/" + OTHER_SPOTIFY,
                    "https://open.spotify.com/playlist/" + OTHER_SPOTIFY,
                    "https://open.spotify.com.evil.example/artist/" + OTHER_SPOTIFY):
            self.assertIsNone(url_identity(url))

    def test_redirect_query_contains_only_explicit_saved_target(self):
        value = recheck(artist(scrapecreators_full_name="Alias",
                              scrapecreators_external_urls_json=[
                                  "https://example.com/redirect?url=" + quote("https://open.spotify.com/artist/" + SPOTIFY)]))
        self.assertEqual(value["decision"], "keep")

    def test_bare_linkpage_slug_is_not_ownership_proof(self):
        value = recheck(artist(scrapecreators_full_name="Other person",
                              scrapecreators_external_urls_json=["https://linktr.ee/ana123"],
                              scrapecreators_bio_link_page_urls_json=["https://linktr.ee/ana123"]))
        self.assertEqual(value["decision"], "review")
        self.assertIn("link_page_url_saved_without_page_contents", value["data_gaps"])

    def test_exact_youtube_channel_qualifies_but_video_does_not(self):
        value = recheck(artist(scrapecreators_full_name="Alias",
                              catalog_youtube_urls_json=["https://www.youtube.com/channel/" + CHANNEL],
                              scrapecreators_external_urls_json=["https://youtube.com/channel/" + CHANNEL]))
        self.assertEqual(value["decision"], "keep")
        self.assertIn("EXACT_CATALOG_YOUTUBE_CHANNEL", value["reason_codes"])
        self.assertIsNone(url_identity("https://youtube.com/watch?v=12345678901"))
        self.assertIsNone(url_identity("https://youtube.com/channel/UCtooShort"))

    def test_native_spotify_and_youtube_ids_are_case_sensitive(self):
        self.assertNotEqual(url_identity("https://open.spotify.com/artist/" + "A" * 22),
                            url_identity("https://open.spotify.com/artist/" + "a" * 22))
        self.assertNotEqual(url_identity("https://youtube.com/channel/" + CHANNEL),
                            url_identity("https://youtube.com/channel/UC" + "a" * 22))

    def test_exact_crossplatform_handles_preserve_punctuation(self):
        good = recheck(artist(catalog_tiktok_urls_json=["https://www.tiktok.com/@Ana123"]))
        bad = recheck(artist(catalog_tiktok_urls_json=["https://www.tiktok.com/@ana.123"]))
        self.assertEqual(good["decision"], "keep")
        self.assertIn("EXACT_CATALOG_SOCIAL_HANDLE", good["reason_codes"])
        self.assertEqual(bad["decision"], "review")

    def test_other_social_conflict_overrides_even_a_correct_spotify_link(self):
        value = recheck(artist(catalog_twitter_urls_json=["https://x.com/different"],
                              scrapecreators_external_urls_json=["https://open.spotify.com/artist/" + SPOTIFY]))
        self.assertEqual(value["decision"], "review")
        self.assertIn("CONFLICT_NO_CATALOG_SOCIAL_MATCH_IN_SAVED_CAPTURE", value["reason_codes"])

    def test_one_matching_social_is_enough_to_clear_no_social_match_conflict(self):
        value = recheck(artist(catalog_twitter_urls_json=["https://x.com/different"],
                              catalog_tiktok_urls_json=["https://tiktok.com/@ana123"]))
        self.assertEqual(value["decision"], "keep")

    def test_channel_id_is_not_a_public_handle(self):
        value = recheck(artist(selected_handle=CHANNEL.casefold(),
                              catalog_youtube_urls_json=["https://youtube.com/channel/" + CHANNEL]))
        self.assertNotIn("EXACT_CATALOG_SOCIAL_HANDLE", value["qualifying_match_codes"])

    def test_nonmusic_categories_and_music_exceptions(self):
        for category in ("Writer", "Gamer", "Athlete", "Chef", "Entertainment website", "Fan page"):
            self.assertIn("CONFLICT_NON_MUSIC_CATEGORY", recheck(artist(scrapecreators_category=category))["reason_codes"])
        for category in ("Songwriter", "Music Producer", "DJ", "Musician/band"):
            self.assertEqual(recheck(artist(scrapecreators_category=category))["decision"], "keep")

    def test_member_personal_account_overrides_name(self):
        member = recheck(artist(scrapecreators_biography="Vocalist of @thegroup"))
        personal = recheck(artist(scrapecreators_biography="My personal account. Official page: @thegroup"))
        group = recheck(artist(scrapecreators_biography="Our members: @member1 @member2"))
        self.assertIn("CONFLICT_MEMBER_OR_PERSONAL_ACCOUNT", member["reason_codes"])
        self.assertIn("CONFLICT_MEMBER_OR_PERSONAL_ACCOUNT", personal["reason_codes"])
        self.assertEqual(group["decision"], "keep")

    def test_promoted_release_requires_stored_title_and_does_not_strip_title_fillers(self):
        row = artist(scrapecreators_biography='New single "The Music" out now')
        match = recheck(row, {"track_titles": ["The Music"]})
        missing = recheck(row, {"track_titles": ["Other Song"]})
        unavailable = recheck(row)
        self.assertEqual(match["decision"], "keep")
        self.assertIn("REVIEW_PROMOTED_RELEASE_NOT_IN_SAVED_CATALOG", missing["reason_codes"])
        self.assertIn("REVIEW_PROMOTED_RELEASE_NOT_IN_SAVED_CATALOG", unavailable["reason_codes"])
        self.assertEqual(missing["check_statuses"]["promoted_release"], "not_found_in_partial_catalog")

    def test_quoted_nonrelease_is_not_a_release_claim(self):
        self.assertEqual(recheck(artist(scrapecreators_biography='"Live and let live"'))["decision"], "keep")

    def test_ascii_quoted_and_unquoted_release_announcements(self):
        for bio in ("New single 'Heaven' out now", "New single Heaven out now"):
            value = recheck(artist(scrapecreators_biography=bio), {"track_titles": ["Other Track"]})
            self.assertIn("REVIEW_PROMOTED_RELEASE_NOT_IN_SAVED_CATALOG", value["reason_codes"])
            self.assertEqual(value["evidence"]["promoted_release_titles"], ["Heaven"])

    def test_explicit_genre_and_language_clashes(self):
        value = recheck(artist(scrapecreators_biography="Spanish rock band"), {"genres": ["turkish-hip-hop"]})
        self.assertIn("CONFLICT_EXPLICIT_GENRE_CLASH", value["reason_codes"])
        self.assertIn("CONFLICT_EXPLICIT_MUSIC_LANGUAGE_CLASH", value["reason_codes"])

    def test_genre_overlap_and_no_country_language_guess(self):
        value = recheck(artist(scrapecreators_biography="Rap artist, hello from Turkey"),
                        {"genres": ["hip-hop", "rap-rock"]})
        self.assertEqual(value["decision"], "keep")
        self.assertEqual(value["check_statuses"]["language"], "not_explicit_in_bio")

    def test_missing_genre_facts_are_review_not_a_manufactured_clash(self):
        value = recheck(artist(scrapecreators_biography="A rap artist"))
        self.assertIn("REVIEW_CATALOG_GENRE_UNAVAILABLE", value["reason_codes"])
        self.assertNotIn("CONFLICT_EXPLICIT_GENRE_CLASH", value["reason_codes"])

    def test_binding_mismatch_and_unusable_capture_are_held(self):
        self.assertIn("CATALOG_IDENTITY_BINDING_UNAVAILABLE_OR_CHANGED",
                      recheck(artist(), {"catalog_binding": "unavailable_or_changed"})["reason_codes"])
        self.assertIn("CAPTURE_NOT_USABLE", recheck(artist(capture_status="failed"))["reason_codes"])


if __name__ == "__main__":
    unittest.main()
