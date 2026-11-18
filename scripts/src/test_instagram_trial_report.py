import unittest

from instagram_proof_trial import digest
from report_instagram_locked_trial import cost_summary, evaluate, provenance


def fixtures():
    rows, controls = [], []
    for group in ("review", "backtest"):
        for i in range(100):
            pid = str(i + (100 if group == "backtest" else 0))
            row = {"profile_id": pid, "cm_artist": pid, "artist_name": "Example " + pid,
                   "group": group, "state": "UNFINISHED", "proof": [], "instagram_url": None}
            rows.append(row)
            if group == "backtest":
                controls.append({"profile_id": pid, "cm_artist": pid,
                                 "accepted_urls": ["https://instagram.com/example" + pid + "/"]})
    return rows, controls


class ReportTests(unittest.TestCase):
    def test_denominators_preserve_all_unfinished(self):
        rows, controls = fixtures()
        result, _ = evaluate(rows, controls)
        self.assertEqual(result["review"]["percent"]["UNFINISHED"], 100)
        self.assertEqual(result["backtest"]["wrongly_not_found"], 0)
        self.assertIsNone(result["backtest"]["agreement_among_verified_percent"])

    def test_missing_outcomes_refused(self):
        rows, controls = fixtures()
        with self.assertRaises(ValueError):
            evaluate(rows[:-1], controls)

    def test_match_vs_different_over_original_100(self):
        rows, controls = fixtures()
        for n, url in ((100, "https://www.instagram.com/example100/"),
                       (101, "https://www.instagram.com/different/")):
            rows[n].update(state="VERIFIED", instagram_url=url, proof=[{"instagram_url": url}])
        rows[102]["state"] = "NOT_FOUND"
        result, _ = evaluate(rows, controls)
        b = result["backtest"]
        self.assertEqual(b["same_locked_link_percent_all_100"], 1)
        self.assertEqual(b["different_locked_link_percent_all_100"], 1)
        self.assertEqual(b["agreement_among_verified_percent"], 50)
        self.assertEqual(b["wrongly_not_found_percent_all_100"], 1)

    def test_duplicate_outcomes_refused(self):
        rows, controls = fixtures()
        rows[-1] = rows[-2]
        with self.assertRaises(ValueError):
            evaluate(rows, controls)

    def test_no_proof_cannot_enter_verified_metrics(self):
        rows, controls = fixtures()
        rows[0].update(state="VERIFIED", instagram_url="https://www.instagram.com/example/")
        with self.assertRaises(ValueError):
            evaluate(rows, controls)

    def test_discovery_routes_not_double_counted(self):
        row = {"state": "VERIFIED", "group": "review", "instagram_url": "https://www.instagram.com/example/",
               "discovered_candidates": [{"url": "https://www.instagram.com/example/"}],
               "proof": [{"kind": "artist_page_links_to_instagram"}]}
        stats = provenance([row])
        self.assertEqual(stats["review"]["discovery_routes_exclusive"], {"both": 1})
        self.assertEqual(stats["all"]["verified"], 1)

    def test_failed_attempt_in_cost_not_discarded(self):
        rows, _ = fixtures()
        row = rows[0]
        query = '"Example 0" musician Instagram site:instagram.com'
        key = digest({"kind": "serper", "params": {"q": query, "num": 10}})
        events = [{"event": "reserved", "request_id": key, "kind": "serper", "reserved_cents": 2},
                  {"event": "acknowledged", "request_id": key, "kind": "serper"}]
        spend = cost_summary(events, rows)
        self.assertEqual(spend["estimated_review_cohort_usd"], .001)
        self.assertEqual(spend["unattributed_estimated_consumption_usd"], 0)
        self.assertEqual(spend["conservative_reserved_usd"], .02)


if __name__ == "__main__":
    unittest.main()
