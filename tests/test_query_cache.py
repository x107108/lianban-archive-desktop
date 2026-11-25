"""Browser query caches must skip repeated work and observe committed local edits."""
from contextlib import closing
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

import app
import app_version
import database as db
import intraday


class LocalQueryCacheTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).parent / "test-data" / ("query-cache-" + uuid4().hex)
        self.root.mkdir(parents=True)
        self.path = self.root / "archive.sqlite3"
        self.conn = db.connect(self.path)
        db.set_settings(self.conn, range_start="2026-10-13", range_end="2026-11-24")
        db.save_day(self.conn, "2026-10-13", [{"code": "001229", "name": "测试股", "boards": 1}], "synthetic")
        self.server = SimpleNamespace(db_path=self.path)
        self.stock_path = "/api/stock?code=001229"

    def tearDown(self):
        self.conn.close()

    def request(self, path, etag=""):
        handler = object.__new__(app.Handler)
        handler.path, handler.server = path, self.server
        handler.headers, handler.wfile = {"If-None-Match": etag}, io.BytesIO()
        response = {"headers": {}}
        handler.send_response = lambda status: response.update(status=status)
        handler.send_header = lambda key, value: response["headers"].update({key: value})
        handler.end_headers = lambda: None
        handler.do_GET()
        response["body"] = handler.wfile.getvalue()
        return response

    def test_refresh_reuses_large_browser_payload_without_recomputing(self):
        payload = {"rows": [], "large": "样本" * 200000}
        with patch.object(app, "read_api", return_value=payload) as read:
            first = self.request(self.stock_path)
            self.assertGreater(len(first["body"]), 512 * 1024)
            self.assertEqual(first["headers"]["Cache-Control"], "private, no-cache")
            self.assertEqual(first["status"], 200)
            cached = self.request(self.stock_path, first["headers"]["ETag"])
            self.assertEqual(cached["status"], 304)
            self.assertEqual(cached["body"], b"")
            self.assertEqual(cached["headers"]["ETag"], first["headers"]["ETag"])
            self.assertEqual(read.call_count, 1)
            # If the browser evicted its body, an unconditional request still gets a full result.
            self.assertEqual(self.request(self.stock_path)["status"], 200)
            self.assertEqual(read.call_count, 2)

    def test_tags_notes_blacklist_and_corrected_archive_invalidate_cache(self):
        mutations = [lambda: db.save_stock_tags(self.conn, "001229", ["自定义标签"], 0),
                     lambda: db.save_stock_note(self.conn, "001229", "新增备注", 0),
                     lambda: db.save_blacklist(self.conn, "001229", "add"),
                     lambda: db.save_day(self.conn, "2026-10-13", [{"code": "001229", "name": "更正股", "boards": 2}], "correction")]
        previous = self.request(self.stock_path)
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                mutate()
                current = self.request(self.stock_path, previous["headers"]["ETag"])
                self.assertEqual(current["status"], 200)
                self.assertNotEqual(current["headers"]["ETag"], previous["headers"]["ETag"])
                previous = current
        stock = json.loads(previous["body"])["stock"]
        self.assertEqual(stock["tags"], ["自定义标签"])
        self.assertEqual(stock["note"], "新增备注")
        self.assertTrue(stock["blacklisted"])
        self.assertEqual(json.loads(previous["body"])["rows"][0]["boards"], 2)

    def test_wal_commit_and_checkpoint_are_both_observed(self):
        old = app.query_etag(self.path, self.stock_path)
        with closing(db.connect(self.path)) as writer:
            db.set_settings(writer, suspension_revision=1)
        committed = app.query_etag(self.path, self.stock_path)
        self.assertNotEqual(old, committed, "a WAL commit invalidates the old browser copy before checkpoint")
        self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.assertNotEqual(old, app.query_etag(self.path, self.stock_path))

    def test_date_cache_observes_separate_seal_time_database(self):
        route = "/api/date?date=2026-10-13"
        first = self.request(route)
        self.assertEqual(self.request(route, first["headers"]["ETag"])["status"], 304)
        with closing(intraday.connect(intraday.store_path(self.path))) as minute, minute:
            minute.execute("INSERT INTO seal_times VALUES (?,?,?,?,?)", ("2026-10-13", "{}", "test", "2026-11-24", ""))
        fresh = self.request(route, first["headers"]["ETag"])
        self.assertEqual(fresh["status"], 200)
        self.assertTrue(json.loads(fresh["body"])["time_coverage"]["cached"])

    def test_query_parameters_database_and_program_version_separate_validators(self):
        original = app.query_etag(self.path, self.stock_path)
        for route in ("/api/stock?code=002579", self.stock_path + "&exclude_latest=1",
                      "/api/comparison?code=001229&peer=002579&exclude_st=1"):
            self.assertNotEqual(original, app.query_etag(self.path, route))
        other = self.root / "other.sqlite3"
        with closing(db.connect(other)):
            self.assertNotEqual(original, app.query_etag(other, self.stock_path))
        with patch.object(app_version, "VERSION", "different-build"):
            self.assertNotEqual(original, app.query_etag(self.path, self.stock_path))
        self.assertIsNone(app.query_etag(self.path, "/api/meta"))
        self.assertIsNone(app.query_etag(":memory:", self.stock_path))

    def test_pending_provisional_missing_and_errors_are_not_cached(self):
        cases = [(self.stock_path, {"cycle_verification_pending": True}),
                 ("/api/date?date=2026-11-24", {"provisional": True, "data_status": "provisional"}),
                 ("/api/date?date=2026-10-13", {"data_status": "missing"}), ("/api/missing", None)]
        for route, data in cases:
            with self.subTest(route=route, data=data), patch.object(app, "read_api", return_value=data):
                response = self.request(route)
                self.assertEqual(response["headers"]["Cache-Control"], "no-store")
                self.assertNotIn("ETag", response["headers"])
        response = self.request("/api/stock?code=bad")
        self.assertEqual(response["status"], 400)
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")

    def test_cache_hits_keep_suspension_verification_and_date_checks(self):
        refresher = Mock()
        refresher.maybe_refresh_cycles.return_value = False
        self.server.suspension_refresher = refresher
        for route in (self.stock_path, "/api/comparison?code=001229&peer=002579", "/api/date?date=2026-10-13"):
            with patch.object(app, "read_api", return_value={"data_status": "ok"}) as read:
                first = self.request(route)
                read.reset_mock()
                cached = self.request(route, first["headers"]["ETag"])
                self.assertEqual(cached["status"], 304)
                read.assert_not_called()
        self.assertIn(unittest.mock.call("001229"), refresher.maybe_refresh_cycles.call_args_list)
        self.assertIn(unittest.mock.call("002579"), refresher.maybe_refresh_cycles.call_args_list)
        refresher.maybe_refresh.assert_called_once_with("2026-10-13")
        refresher.maybe_refresh_cycles.return_value = True
        with patch.object(app, "read_api", return_value={"cycle_verification_pending": True}) as read:
            response = self.request(self.stock_path, app.query_etag(self.path, self.stock_path))
            self.assertEqual(response["status"], 200)
            self.assertNotIn("ETag", response["headers"])
            read.assert_called_once()

    def test_write_during_query_does_not_label_old_data_with_a_new_validator(self):
        def read(*_):
            db.set_settings(self.conn, suspension_revision=2)
            return {"rows": []}
        old = app.query_etag(self.path, self.stock_path)
        with patch.object(app, "read_api", side_effect=read):
            first = self.request(self.stock_path)
        self.assertEqual(first["headers"]["ETag"], old)
        with patch.object(app, "read_api", return_value={"rows": []}) as fresh:
            self.assertEqual(self.request(self.stock_path, old)["status"], 200)
            fresh.assert_called_once()

    def test_other_archive_pages_reuse_cached_results_without_cycle_side_effects(self):
        self.server.suspension_refresher = Mock()
        routes = ("/api/tags", "/api/tag-stocks?tag=测试", "/api/blacklist", "/api/stock-tags?code=001229",
                  "/api/stock-note?code=001229", "/api/announcement", "/api/site-links",
                  "/api/shareholder-alerts?date=2026-10-13", "/api/stock-shareholders?code=001229&date=2026-10-13",
                  "/api/seven-boards?exclude_st=1&exclude_gem=1")
        for route in routes:
            with self.subTest(route=route), patch.object(app, "read_api", return_value={"date_status": "confirmed"}) as read:
                first = self.request(route)
                cached = self.request(route, first["headers"]["ETag"])
                self.assertEqual(cached["status"], 304)
                self.assertEqual(read.call_count, 1)
        self.server.suspension_refresher.maybe_refresh_cycles.assert_not_called()
        self.server.suspension_refresher.maybe_refresh.assert_not_called()

    def test_editing_notes_and_tags_refreshes_management_pages(self):
        note_route = "/api/stock-note?code=001229"
        first = self.request(note_route)
        db.save_stock_note(self.conn, "001229", "更新后的备注", 0)
        current = self.request(note_route, first["headers"]["ETag"])
        self.assertEqual(current["status"], 200)
        self.assertEqual(json.loads(current["body"])["content"], "更新后的备注")
        tag_route = "/api/stock-tags?code=001229"
        first = self.request(tag_route)
        db.save_stock_tags(self.conn, "001229", ["新的标签"], 0)
        current = self.request(tag_route, first["headers"]["ETag"])
        self.assertEqual(current["status"], 200)
        self.assertEqual(json.loads(current["body"])["tags"], ["新的标签"])
        first = self.request("/api/blacklist")
        db.save_blacklist(self.conn, "001229", "add")
        current = self.request("/api/blacklist", first["headers"]["ETag"])
        self.assertEqual(current["status"], 200)
        self.assertEqual(json.loads(current["body"])["rows"][0]["code"], "001229")

    def test_historical_minute_pages_and_seven_board_results_observe_minute_wal(self):
        routes = ("/api/intraday?date=2026-10-13", "/api/intraday/stock?date=2026-10-13&code=001229",
                  "/api/intraday/timeline?date=2026-10-13&multiple=10", "/api/intraday/comparison?date=2026-10-13",
                  "/api/seven-boards?exclude_st=1")
        with patch.object(db, "now_iso", return_value="2026-11-24T18:00:00+08:00"):
            for route in routes:
                with self.subTest(route=route), patch.object(app, "read_api", return_value={"status": "ok", "jobs": []}) as read:
                    first = self.request(route)
                    self.assertEqual(self.request(route, first["headers"]["ETag"])["status"], 304)
                    with closing(intraday.connect(intraday.store_path(self.path))) as minute, minute:
                        minute.execute("INSERT OR REPLACE INTO seal_times VALUES (?,?,?,?,?)",
                                       ("2026-10-13", "{}", route, "2026-11-24", ""))
                    self.assertEqual(self.request(route, first["headers"]["ETag"])["status"], 200)
                    self.assertEqual(read.call_count, 2)
            self.assertNotEqual(app.query_etag(self.path, routes[2]),
                                app.query_etag(self.path, routes[2].replace("multiple=10", "multiple=20")))

    def test_today_and_future_minute_queries_always_make_live_refresh_decisions(self):
        with patch.object(db, "now_iso", return_value="2026-11-24T09:30:00+08:00"):
            for route in ("/api/intraday", "/api/intraday/stock", "/api/intraday/timeline", "/api/intraday/comparison"):
                for suffix in ("", "?date=2026-11-24", "?date=2026-11-25"):
                    with self.subTest(route=route + suffix):
                        self.assertIsNone(app.query_etag(self.path, route + suffix))
                        with patch.object(app, "read_api", return_value={"status": "ok"}) as read:
                            response = self.request(route + suffix, 'W/"previous"')
                            self.assertEqual(response["status"], 200)
                            self.assertNotIn("ETag", response["headers"])
                            read.assert_called_once()
            first = app.query_etag(self.path, self.stock_path)
        with patch.object(db, "now_iso", return_value="2026-11-25T00:00:00+08:00"):
            self.assertNotEqual(first, app.query_etag(self.path, self.stock_path), "day-dependent profile flags renew after midnight")

    def test_unfinished_and_failed_new_page_results_are_not_saved(self):
        cases = [("/api/intraday/stock?date=2026-10-13&code=001229", {"status": "partial"}),
                 ("/api/intraday/stock?date=2026-10-13&code=001229", {"status": "ok", "needs_collection": True}),
                 ("/api/intraday/timeline?date=2026-10-13", {"jobs": [{"code": "001229"}]}),
                 ("/api/intraday/timeline?date=2026-10-13", {"time_coverage": {"missing": 1}}),
                 ("/api/stock-shareholders?code=001229&date=2026-10-13", {"date_status": "provisional"}),
                 ("/api/stock-shareholders?code=001229&date=2026-10-13", {"date_status": "confirmed", "status": "updating"})]
        for route, data in cases:
            with self.subTest(route=route, data=data), patch.object(app, "read_api", return_value=data):
                response = self.request(route)
                self.assertNotIn("ETag", response["headers"])
                self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        for route in ("/api/meta", "/api/stocks?q=测试", "/api/stock-market-values?code=001229&date=2026-11-24", "/api/stock-subsidiaries?code=001229"):
            self.assertIsNone(app.query_etag(self.path, route), "existing clock-based data refreshes stay active")


if __name__ == "__main__":
    unittest.main()
