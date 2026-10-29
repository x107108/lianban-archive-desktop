"""Disclosed-name matching, snapshot replacement and today's live/close priority."""
from contextlib import closing
from datetime import datetime
import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
import unittest

import app
import database as db
import shareholders as sh


class ShareholderTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.save_day(self.conn, "2026-10-28", [
            {"code": code, "name": name, "boards": 1} for code, name in
            [("000001", "本股"), ("000002", "两个共同股东"), ("000003", "同涨票"), ("000004", "退出票")]], "synthetic")
        self.now = datetime(2026, 10, 29, 10, 30, tzinfo=db.TZ)
        self.seed(["000001", "000002", "000003", "000004"], {
            "000001": ["共同机构", "另一机构"], "000002": ["共同机构", "另一机构"],
            "000003": ["共同机构"], "000004": ["共同机构"]})

    def tearDown(self):
        self.conn.close()

    def seed(self, codes, names, day="2026-09-30"):
        rows = [{"code": code, "holder_name": name, "holder_key": name, "holder_type": "其他", "report_date": day}
                for code in codes for name in names.get(code, [])]
        sh.save_batch(self.conn, codes, {"total": rows, "float": rows})

    def view(self, **kwargs):
        return sh.stock_view(self.conn, "000001", now=self.now, **kwargs)

    def live(self, codes, day="2026-10-29"):
        import json
        with self.conn:
            self.conn.execute("INSERT OR REPLACE INTO live_pools VALUES (?,?,?,?,?,?)", (day,
                json.dumps([{"code": code} for code in codes]), "synthetic", self.now.isoformat(), None, ""))

    def test_deduplication_and_current_snapshot_not_all_history(self):
        result = self.view()
        self.assertEqual([r["code"] for r in result["rows"]], ["000002", "000003", "000004"])
        self.assertEqual(result["rows"][0]["shared_count"], 2)
        self.assertEqual(len(result["rows"][0]["holders"][0]["reports"]), 2)
        self.seed(["000004"], {"000004": ["新机构"]}, "2026-10-15")
        self.assertNotIn("000004", [r["code"] for r in self.view()["rows"]])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], 4)

    def test_today_priority_requires_both_stocks_in_current_snapshot(self):
        self.live(["000001", "000003"])
        result = self.view()
        self.assertEqual(result["rows"][0]["code"], "000003")
        self.assertTrue(result["rows"][0]["today_together"])
        self.assertEqual(result["today_status"], "provisional")
        self.live(["000003"])
        self.assertFalse(any(r["today_together"] for r in self.view()["rows"]))
        self.assertFalse(any(r["today_together"] for r in self.view(include_live=False)["rows"]))

    def test_alerts_require_a_different_stock_in_todays_pool(self):
        self.assertEqual(sh.today_alerts(self.conn, now=self.now)["rows"], [])
        self.live(["000001"])
        self.assertEqual(sh.today_alerts(self.conn, now=self.now)["rows"], [], "a stock cannot match itself across the two holder scopes")
        self.live(["000001", "000003"])
        alerts = sh.today_alerts(self.conn, now=self.now)
        self.assertEqual(alerts["today"], "2026-10-29")
        self.assertEqual(alerts["rows"], [{"code": "000001", "types": ["其他"]}, {"code": "000003", "types": ["其他"]}])
        self.assertEqual(sh.today_alerts(self.conn, include_live=False, now=self.now)["rows"], [])
        self.live(["000003"])
        self.assertEqual(sh.today_alerts(self.conn, now=self.now)["rows"], [], "leaving the live pool clears the signal")

    def test_alert_categories_match_popup_and_confirmed_close_supersedes_live(self):
        self.conn.execute("UPDATE stock_shareholders SET holder_type='QFII' WHERE code='000003'")
        self.conn.commit()
        self.live(["000001", "000003"])
        alerts = sh.today_alerts(self.conn, now=self.now)
        self.assertEqual(alerts["rows"][0], {"code": "000001", "types": ["QFII"]})
        self.assertEqual(self.view()["rows"][0]["holders"][0]["type"], "QFII")
        db.save_day(self.conn, "2026-10-29", [{"code": c, "name": c, "boards": 1} for c in ["000001", "000002"]], "synthetic")
        self.assertEqual(sh.today_alerts(self.conn, now=self.now)["rows"],
                         [{"code": "000001", "types": ["其他"]}, {"code": "000002", "types": ["其他"]}])
        self.seed(["000002"], {"000002": ["独立股东"]}, "2026-10-15")
        self.assertEqual(sh.today_alerts(self.conn, now=self.now)["rows"], [], "new holder snapshots remove obsolete matches")

    def test_yesterday_never_becomes_today_and_confirmed_close_wins(self):
        self.live(["000001", "000003"], day="2026-10-28")
        self.assertEqual(self.view()["today_status"], "unavailable")
        self.live(["000001", "000003"])
        db.save_day(self.conn, "2026-10-29", [{"code": c, "name": c, "boards": 1} for c in ["000001", "000002"]], "synthetic")
        result = self.view()
        self.assertEqual(result["today_status"], "confirmed")
        self.assertTrue(result["rows"][0]["today_together"])
        self.assertEqual(result["rows"][0]["code"], "000002")
        self.assertFalse(next(r for r in result["rows"] if r["code"] == "000003")["today_together"])

    def test_failed_or_regressed_refresh_keeps_previous_cache_atomically(self):
        before = [tuple(r) for r in self.conn.execute("SELECT * FROM stock_shareholders")]
        with self.assertRaises(ValueError):
            self.seed(["000001", "000002"], {"000001": ["更新机构"]}, "2026-10-15")
        self.assertEqual([tuple(r) for r in self.conn.execute("SELECT * FROM stock_shareholders")], before)
        with self.assertRaises(ValueError):
            self.seed(["000001"], {"000001": ["旧机构"]}, "2026-06-30")
        self.assertEqual([tuple(r) for r in self.conn.execute("SELECT * FROM stock_shareholders")], before)

    def test_boundary_normalization_and_future_date_rejection(self):
        row = {"SECUCODE": "000001.SZ", "SECURITY_CODE": "000001", "END_DATE": "2026-09-30 00:00:00",
               "NOTICE_DATE": "2026-10-24", "HOLDER_NAME": " 某机构（有限合伙） ", "HOLDER_NEWTYPE": "投资公司"}
        payload = {"success": True, "result": {"count": 1, "pages": 1, "data": [row]}}
        rows, _, _ = sh.normalize_rows(payload, {"000001"}, "2026-10-29")
        self.assertEqual(rows[0]["holder_key"], "某机构(有限合伙)")
        for key, value in [("SECURITY_CODE", "000002"), ("END_DATE", "2026-11-02"),
                           ("NOTICE_DATE", "2026-10-30"), ("HOLDER_NAME", " ")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                sh.normalize_rows({"success": True, "result": {"count": 1, "pages": 1, "data": [{**row, key: value}]}}, {"000001"}, "2026-10-29")

    def test_read_api_and_persisted_empty_profile(self):
        root = Path(__file__).parent / "test-data" / ("shareholders-" + uuid4().hex)
        path = root / "archive.sqlite3"
        with closing(db.connect(path)) as conn:
            sh.save_batch(conn, ["000001"], {"total": [], "float": []})
        result = app.read_api(SimpleNamespace(db_path=path, read_only=True), "/api/stock-shareholders?code=000001")
        self.assertEqual(len(result["profiles"]), 2)
        self.assertEqual(result["rows"], [])
        self.assertTrue(all(p["report_date"] is None for p in result["profiles"]))
        with self.assertRaises(ValueError):
            app.read_api(SimpleNamespace(db_path=path), "/api/stock-shareholders?code=bad")

    def test_second_scope_failure_never_replaces_first_scope(self):
        root = Path(__file__).parent / "test-data" / ("shareholder-fetch-" + uuid4().hex)
        path = root / "archive.sqlite3"
        with closing(db.connect(path)) as conn:
            db.save_day(conn, "2026-10-28", [{"code": "000001", "name": "本股", "boards": 1}], "synthetic")
        with patch.object(sh, "fetch_batch", side_effect=[[], OSError("offline")]), self.assertRaises(OSError):
            sh.refresh(path)
        with closing(db.connect(path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM shareholder_profiles").fetchone()[0], 0)

    def test_missing_latest_flag_recovers_eligible_snapshot_and_checks_pagination(self):
        root = Path(__file__).parent / "test-data" / ("shareholder-source-" + uuid4().hex)
        row = {"SECUCODE": "000001.SZ", "SECURITY_CODE": "000001", "END_DATE": "2025-09-30",
               "HOLDER_NAME": "共同机构", "NOTICE_DATE": "2025-10-24"}
        no_data = {"success": False, "code": 9201, "message": "返回数据为空", "result": None}
        payload = {"success": True, "result": {"count": 1, "pages": 1, "data": [row]}}
        def response(value):
            return io.BytesIO(json.dumps(value).encode())
        with patch.object(sh, "urlopen", side_effect=[response(no_data), response(payload)]) as fetch, patch.object(sh.time, "sleep"):
            rows = sh.fetch_batch(["000001"], "total", root)
        self.assertEqual(rows[0]["report_date"], "2025-09-30")
        from urllib.parse import parse_qs, urlparse
        params = [parse_qs(urlparse(call.args[0].full_url).query) for call in fetch.call_args_list]
        self.assertIn("IS_MAX_REPORTDATE", params[0]["filter"][0])
        self.assertNotIn("IS_MAX_REPORTDATE", params[1]["filter"][0])
        self.assertIn("END_DATE<=", params[1]["filter"][0])
        incomplete = {"success": True, "result": {"count": 2, "pages": 1, "data": [row]}}
        with patch.object(sh, "urlopen", return_value=response(incomplete)), self.assertRaisesRegex(ValueError, "未完整返回"):
            sh.fetch_batch(["000001"], "total", root)


if __name__ == "__main__":
    unittest.main()
