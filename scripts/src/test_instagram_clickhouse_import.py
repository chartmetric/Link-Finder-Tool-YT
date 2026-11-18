"""Contract tests without issuing database writes."""

import unittest
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

import instagram_clickhouse_import as publication
from verify_instagram_clickhouse_import import python_frame


class PublicationTests(unittest.TestCase):
    def test_selected_schema_keeps_every_original_column_in_order(self):
        source = pq.read_schema(publication.SOURCE)
        target = publication.table_schema()
        self.assertEqual(target.names, source.names + ["export_run_id", "exported_at"])
        for before, after in zip(source, target):
            self.assertEqual(before, after)

    def test_assessed_identifies_candidate_without_relabeling_it_selected(self):
        names = publication.table_schema(assessed=True).names
        self.assertIn("candidate_url", names)
        self.assertIn("selected_url", names)
        self.assertIn("not_selected_reason", names)
        self.assertIn("not_selected_reason_source", names)

    def test_ddl_is_create_only_in_requested_database(self):
        manifest = {"export_run_id": "test-run"}
        for table in (publication.SELECTED, publication.ASSESSED):
            sql = publication.ddl(table, manifest)
            self.assertTrue(sql.startswith("CREATE TABLE `poc_new_verticals`."))
            self.assertNotIn("IF NOT EXISTS", sql)
            self.assertNotIn("REPLACE", sql)
            self.assertNotIn("DROP", sql)
        with self.assertRaises(AssertionError):
            publication.ddl("some_other_table", manifest)

    def test_existing_table_causes_stop_before_any_create_or_insert(self):
        class ExistingTableClient:
            def select(self, query):
                return [{"readonly_mode": 0, "database_exists": 1,
                         "existing": ["musician_instagram_selected"]}]

            def execute(self, *args, **kwargs):
                raise AssertionError("No write is permitted after an existing-table check")

        with patch.object(publication, "Client", ExistingTableClient):
            with self.assertRaisesRegex(RuntimeError, "already exists"):
                publication.prepare()

    def test_readonly_database_causes_stop_before_any_write(self):
        class ReadonlyClient:
            def select(self, query):
                return [{"readonly_mode": 1, "database_exists": 1, "existing": []}]

            def execute(self, *args, **kwargs):
                raise AssertionError("Do not disable readonly or try a different destination")

        with patch.object(publication, "Client", ReadonlyClient):
            with self.assertRaisesRegex(RuntimeError, "read-only"):
                publication.prepare()

    def test_integrity_encoding_distinguishes_null_zero_false_and_empty(self):
        schema = pa.schema([pa.field("value", pa.string())])
        self.assertNotEqual(python_frame({"value": None}, schema), python_frame({"value": ""}, schema))
        bool_schema = pa.schema([pa.field("value", pa.bool_())])
        self.assertEqual(python_frame({"value": False}, bool_schema), b"V1:0;")


if __name__ == "__main__":
    unittest.main()
