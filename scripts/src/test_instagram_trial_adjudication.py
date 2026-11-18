import copy
import unittest

from adjudicate_instagram_locked_trial import assess_without_unrelated_conflicts
from test_instagram_locked_trial import IG, SPOTIFY, fixture

OTHER_SPOTIFY = SPOTIFY[:-1] + "M"


class AdjudicationTests(unittest.TestCase):
    def test_unrelated_profile_does_not_block_supported_target(self):
        a, r, c, p = fixture()
        r["links"] = [IG]
        other = {**c, "url": "https://www.instagram.com/unrelated/", "links": [OTHER_SPOTIFY]}
        before = copy.deepcopy(other)
        result, rejected = assess_without_unrelated_conflicts(a, [r], [c, other], p)
        self.assertEqual(result["state"], "VERIFIED")
        self.assertEqual(rejected, [other["url"]])
        self.assertEqual(other, before)
        self.assertFalse(result["rejected_candidates"][-1]["identity_rejection"])

    def test_only_unrelated_candidate_not_verified_or_manual_conflict(self):
        a, r, c, p = fixture()
        c["links"] = [OTHER_SPOTIFY]
        result, _ = assess_without_unrelated_conflicts(a, [r], [c], p)
        self.assertEqual(result["state"], "NOT_FOUND")

    def test_same_candidate_points_to_expected_and_other_artist_stays_manual(self):
        a, r, c, p = fixture()
        c["links"] = [SPOTIFY, OTHER_SPOTIFY]
        result, rejected = assess_without_unrelated_conflicts(a, [r], [c], p)
        self.assertEqual(result["state"], "MANUAL_REVIEW")
        self.assertEqual(rejected, [])

    def test_artist_anchor_and_candidate_disagree_stays_manual(self):
        a, r, c, p = fixture()
        r["links"] = [IG]
        c["links"] = [OTHER_SPOTIFY]
        result, rejected = assess_without_unrelated_conflicts(a, [r], [c], p)
        self.assertEqual(result["state"], "MANUAL_REVIEW")
        self.assertEqual(rejected, [])

    def test_two_independently_supported_instagrams_stay_manual(self):
        a, r, c, p = fixture()
        r["links"] = ["https://www.instagram.com/second/"]
        c["links"] = [SPOTIFY]
        result, _ = assess_without_unrelated_conflicts(a, [r], [c], p)
        self.assertEqual(result["state"], "MANUAL_REVIEW")

    def test_unrelated_candidate_incomplete_followup_still_holds(self):
        a, r, c, p = fixture()
        r["links"] = [IG]
        other = {**c, "url": "https://www.instagram.com/unrelated/",
                 "links": [OTHER_SPOTIFY], "followups_complete": False}
        result, _ = assess_without_unrelated_conflicts(a, [r], [c, other], p)
        self.assertEqual(result["state"], "UNFINISHED")
        self.assertIsNone(result["instagram_url"])

    def test_failed_search_still_holds_supported_target(self):
        a, r, c, p = fixture()
        r["links"] = [IG]
        p["searches_complete"] = False
        result, _ = assess_without_unrelated_conflicts(a, [r], [c], p)
        self.assertEqual(result["state"], "UNFINISHED")

    def test_name_only_candidate_remains_not_found(self):
        a, r, c, p = fixture()
        c.update(full_name="Example", verified=True, confidence=100)
        result, _ = assess_without_unrelated_conflicts(a, [r], [c], p)
        self.assertEqual(result["state"], "NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
