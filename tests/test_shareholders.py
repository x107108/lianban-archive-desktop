"""Disclosed-name matching, snapshot replacement and today's live/close priority."""
from contextlib import closing
from datetime import datetime
import io
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
import unittest

import app
import database as db
import shareholders as sh
import control_owners as control
import industry


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

    def test_own_holder_lists_keep_scopes_and_dates_separate_from_control_owners(self):
        def holders(names, day):
            return [{"code": "000001", "holder_name": name, "holder_key": name,
                     "holder_type": "其他", "report_date": day} for name in names]
        sh.save_batch(self.conn, ["000001"], {
            "total": holders(["只在总股东", "共同机构"], "2026-10-15"),
            "float": holders(["只在流通", "共同机构"], "2026-09-30")})
        control.save_batch(self.conn, ["000001"], [{"code": "000001", "kind": "actual_controller",
            "holder_key": "上层控制主体", "holder_name": "上层控制主体", "holder_type": "控股机构",
            "via_name": "", "source_url": "https://example.com/control"}], {"000001"})
        result = self.view()
        self.assertEqual(result["name"], "本股")
        self.assertEqual({r["name"] for r in result["own_holders"]["total"]}, {"只在总股东", "共同机构"})
        self.assertEqual({r["name"] for r in result["own_holders"]["float"]}, {"只在流通", "共同机构"})
        self.assertEqual({r["report_date"] for r in result["own_holders"]["total"]}, {"2026-10-15"})
        self.assertEqual({r["report_date"] for r in result["own_holders"]["float"]}, {"2026-09-30"})
        self.assertEqual(result["control_owners"][0]["name"], "上层控制主体")
        self.assertTrue(all("rank" not in r for rows in result["own_holders"].values() for r in rows),
                        "names are not presented as a fabricated ownership rank")

    def test_hong_kong_clearing_is_an_exact_independent_filter_and_alert_category(self):
        clearing = "香港中央结算有限公司"
        nominee = "香港中央结算(代理人)有限公司"
        self.seed(["000001", "000002", "000003", "000004"], {
            "000001": [clearing, nominee], "000002": [clearing],
            "000003": [clearing], "000004": [nominee]})
        # This is a read-time category: existing cached source classifications stay intact.
        self.conn.execute("UPDATE stock_shareholders SET holder_type='QFII' WHERE code='000003' AND scope='float'")
        self.conn.commit()
        self.live(["000001", "000003"])
        result = self.view()
        peer = result["rows"][0]
        self.assertEqual(peer["code"], "000003")
        self.assertEqual(peer["holders"][0]["type"], clearing)
        for rows in result["own_holders"].values():
            self.assertEqual(next(r["type"] for r in rows if r["name"] == clearing), clearing)
            self.assertEqual(next(r["type"] for r in rows if r["name"] == nominee), "其他")
        self.assertEqual(next(p for p in result["rows"] if p["code"] == "000004")["holders"][0]["type"], "其他")
        self.assertEqual(sh.today_alerts(self.conn, now=self.now)["rows"],
                         [{"code": "000001", "types": [clearing]}, {"code": "000003", "types": [clearing]}])
        self.assertEqual(self.conn.execute("SELECT holder_type FROM stock_shareholders WHERE code='000003' AND scope='float'").fetchone()[0], "QFII")

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

    def test_conflicting_total_and_float_categories_have_same_filter_and_alert_type(self):
        self.conn.execute("UPDATE stock_shareholders SET holder_type='QFII' WHERE code='000003' AND scope='float'")
        self.conn.commit()
        self.live(["000001", "000003"])
        holder = self.view()["rows"][0]["holders"][0]
        self.assertEqual(holder["type"], "其他")
        self.assertEqual(sh.today_alerts(self.conn, now=self.now)["rows"][0]["types"], [holder["type"]])

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

    def test_parent_owner_matches_declared_controller_without_changing_its_role(self):
        payload = {"success": True, "result": {"count": 3, "pages": 1, "data": [
            {"SECUCODE": "000001.SZ", "SECURITY_CODE": "000001", "CONTROL_HOLDER": control.PARENT_OWNER_VIA,
             "CONTROL_HOLDER_CODE": "10119054", "REAL_CONTROLER": control.PARENT_OWNER_VIA, "REAL_CONTROLER_CODE": "10119054"},
            {"SECUCODE": "000003.SZ", "SECURITY_CODE": "000003", "CONTROL_HOLDER": "对方集团", "CONTROL_HOLDER_CODE": "1234",
             "REAL_CONTROLER": control.PARENT_OWNER_NAME, "REAL_CONTROLER_CODE": "10012586"},
            {"SECUCODE": "000004.SZ", "SECURITY_CODE": "000004", "CONTROL_HOLDER": None, "CONTROL_HOLDER_CODE": None,
             "REAL_CONTROLER": "其他市人民政府国有资产监督管理委员会",
             "REAL_CONTROLER_CODE": "10012587"}]}}
        records, available, _, _ = control.normalize_page(payload, {"000001", "000003", "000004"})
        control.save_batch(self.conn, ["000001", "000003", "000004"], records, available)
        self.seed(["000001", "000003", "000004"], {"000001": [control.PARENT_OWNER_VIA], "000003": ["独立股东"], "000004": ["无关机构"]})
        self.live(["000001", "000003", "000004"])
        result = self.view()
        self.assertEqual([r["code"] for r in result["rows"]], ["000003"], "same state-ownership category does not imply the same entity")
        holder = result["rows"][0]["holders"][0]
        self.assertEqual(holder["name"], control.PARENT_OWNER_NAME)
        self.assertEqual(holder["type"], "国资")
        self.assertEqual(holder["reports"], [], "retrieval date must not become a shareholder report date")
        self.assertEqual(holder["own_relations"][0]["kind"], "parent_owner")
        self.assertEqual(holder["relations"][0]["kind"], "actual_controller")
        self.assertTrue(result["rows"][0]["today_together"])
        self.assertEqual(next(r["name"] for r in result["control_owners"] if r["kind"] == "actual_controller"), control.PARENT_OWNER_VIA)
        self.assertEqual(sh.today_alerts(self.conn, now=self.now)["rows"],
                         [{"code": "000001", "types": ["国资"]}, {"code": "000003", "types": ["国资"]}])
        control.save_batch(self.conn, ["000001"], [], {"000001"})
        self.assertEqual(self.view()["rows"], [], "changed controls remove former upper-owner matches")
        self.assertEqual(sh.today_alerts(self.conn, now=self.now)["rows"], [])

    def test_direct_and_controller_relationships_count_entity_once_and_share_alert_category(self):
        records = [{"code": code, "kind": kind, "holder_key": "共同机构", "holder_name": "共同机构",
                    "holder_type": "控股机构", "via_name": "", "source_url": "https://example.com/source"}
                   for code in ["000001", "000003"] for kind in ["controller", "actual_controller"]]
        control.save_batch(self.conn, ["000001", "000003"], records, {"000001", "000003"})
        self.live(["000001", "000003"])
        peer = self.view()["rows"][0]
        self.assertEqual(peer["code"], "000003")
        self.assertEqual(peer["shared_count"], 1)
        self.assertEqual(peer["holders"][0]["type"], "控股机构")
        self.assertEqual(len(peer["holders"][0]["relations"]), 2)
        self.assertEqual(len(peer["holders"][0]["reports"]), 2)
        self.assertEqual(sh.today_alerts(self.conn, now=self.now)["rows"],
                         [{"code": "000001", "types": ["控股机构"]}, {"code": "000003", "types": ["控股机构"]}])

    def test_boundary_normalization_and_future_date_rejection(self):
        row = {"SECUCODE": "000001.SZ", "SECURITY_CODE": "000001", "END_DATE": "2026-09-30 00:00:00",
               "NOTICE_DATE": "2026-10-24", "HOLDER_NAME": " 某机构（有限合伙） ", "HOLDER_NEWTYPE": "投资公司", "HOLD_RATIO": None}
        payload = {"success": True, "result": {"count": 1, "pages": 1, "data": [row]}}
        rows, _, _ = sh.normalize_rows(payload, {"000001"}, "2026-10-29")
        self.assertEqual(rows[0]["holder_key"], "某机构(有限合伙)")
        for key, value in [("SECURITY_CODE", "000002"), ("END_DATE", "2026-11-02"),
                           ("NOTICE_DATE", "2026-10-30"), ("HOLDER_NAME", " ")]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                sh.normalize_rows({"success": True, "result": {"count": 1, "pages": 1, "data": [{**row, key: value}]}}, {"000001"}, "2026-10-29")

    def test_ratio_denominators_missing_values_and_invalid_external_data(self):
        row = {"SECUCODE": "000001.SZ", "SECURITY_CODE": "000001", "END_DATE": "2026-09-30",
               "HOLDER_NAME": "同名股东", "HOLD_RATIO": 13.5, "FREE_HOLDNUM_RATIO": 21.110242096267}
        def normalize(record, scope):
            payload = {"success": True, "result": {"count": 1, "pages": 1, "data": [record]}}
            return sh.normalize_rows(payload, {"000001"}, "2026-10-30", scope)[0][0]["holding_ratio"]
        self.assertEqual(normalize(row, "total"), 13.5)
        self.assertEqual(normalize(row, "float"), 21.110242096267)
        self.assertIsNone(normalize({**row, "FREE_HOLDNUM_RATIO": None}, "float"))
        self.assertEqual(normalize({**row, "HOLD_RATIO": 0}, "total"), 0)
        self.assertEqual(normalize({**row, "HOLD_RATIO": "12.3456"}, "total"), 12.3456)
        for value in [-1, 101, True, "NaN", "Infinity", "bad"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize({**row, "HOLD_RATIO": value}, "total")
        with self.assertRaisesRegex(ValueError, "字段缺失"):
            normalize({k: v for k, v in row.items() if k != "FREE_HOLDNUM_RATIO"}, "float")

    def test_saved_ratios_stay_with_their_scope_date_and_sort_unknown_after_zero(self):
        def records(ratios, day):
            return [{"code": "000001", "holder_name": name, "holder_key": name, "holder_type": "其他",
                     "report_date": day, "holding_ratio": ratio} for name, ratio in ratios]
        sh.save_batch(self.conn, ["000001"], {
            "total": records([("股东甲", 46.74), ("股东乙", 1.25), ("股东零", 0), ("股东未披露", None)], "2026-10-15"),
            "float": records([("股东甲", 47.915932123188), ("股东乙", 3.5)], "2026-09-30")})
        own = self.view()["own_holders"]
        self.assertEqual([r["holding_ratio"] for r in own["total"]], [46.74, 1.25, 0, None])
        self.assertEqual(own["float"][0]["holding_ratio"], 47.915932123188)
        self.assertEqual(own["float"][0]["report_date"], "2026-09-30")
        self.assertTrue(all(r[0] == 1 for r in self.conn.execute("SELECT ratio_checked FROM shareholder_profiles WHERE code='000001'")))

    def test_existing_cache_migrates_and_backfills_even_when_24h_cache_is_fresh(self):
        path = Path(__file__).parent / "test-data" / ("holder-ratio-" + uuid4().hex + ".sqlite3")
        with closing(sqlite3.connect(path)) as old, old:
            old.executescript("CREATE TABLE stock_shareholders(code TEXT,scope TEXT,holder_key TEXT,holder_name TEXT,holder_type TEXT,report_date TEXT,PRIMARY KEY(code,scope,holder_key));"
                              "CREATE TABLE shareholder_profiles(code TEXT,scope TEXT,report_date TEXT,source TEXT,fetched_at TEXT,PRIMARY KEY(code,scope));")
            old.execute("INSERT INTO stock_shareholders VALUES ('000001','total','股东','股东','个人','2026-09-30')")
            old.executemany("INSERT INTO shareholder_profiles VALUES ('000001',?,'2026-09-30','旧来源',?)", [(scope, db.now_iso()) for scope in sh.REPORTS])
        with closing(db.connect(path)) as conn:
            db.save_day(conn, "2026-10-28", [{"code": "000001", "name": "本股", "boards": 1}], "synthetic")
            self.assertIsNone(conn.execute("SELECT holding_ratio FROM stock_shareholders").fetchone()[0])
            self.assertEqual(conn.execute("SELECT MIN(ratio_checked) FROM shareholder_profiles").fetchone()[0], 0)
            db.set_settings(conn, shareholder_fetched_at=db.now_iso(), shareholder_requested=1)
        with patch.object(industry.threading, "Thread") as worker:
            sh.Refresher(path).maybe_refresh()
            worker.assert_called_once()
        record = {"code": "000001", "holder_key": "股东", "holder_name": "股东", "holder_type": "个人",
                  "report_date": "2026-09-30", "holding_ratio": 20.25}
        with patch.object(sh, "fetch_batch", return_value=[record]) as fetch:
            self.assertEqual(sh.refresh(path), 1)
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual(sh.refresh(path), 0)
        with closing(db.connect(path)) as conn:
            self.assertEqual(conn.execute("SELECT MIN(ratio_checked) FROM shareholder_profiles").fetchone()[0], 1)
            self.assertEqual(sh.stock_view(conn, "000001")["own_holders"]["total"][0]["holding_ratio"], 20.25)
        with patch.object(industry.threading, "Thread") as worker:
            sh.Refresher(path).maybe_refresh()
            worker.assert_not_called()

    def test_read_api_and_persisted_empty_profile(self):
        root = Path(__file__).parent / "test-data" / ("shareholders-" + uuid4().hex)
        path = root / "archive.sqlite3"
        with closing(db.connect(path)) as conn:
            sh.save_batch(conn, ["000001"], {"total": [], "float": []})
        result = app.read_api(SimpleNamespace(db_path=path, read_only=True), "/api/stock-shareholders?code=000001")
        self.assertEqual(len(result["profiles"]), 2)
        self.assertEqual(result["rows"], [])
        self.assertEqual(result["own_holders"], {"total": [], "float": []})
        self.assertEqual(result["name"], "000001")
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
               "HOLDER_NAME": "共同机构", "NOTICE_DATE": "2025-10-24", "HOLD_RATIO": 12.34}
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
        self.assertIn("HOLD_RATIO", params[0]["columns"][0])
        self.assertEqual(rows[0]["holding_ratio"], 12.34)
        incomplete = {"success": True, "result": {"count": 2, "pages": 1, "data": [row]}}
        with patch.object(sh, "urlopen", return_value=response(incomplete)), self.assertRaisesRegex(ValueError, "未完整返回"):
            sh.fetch_batch(["000001"], "total", root)


if __name__ == "__main__":
    unittest.main()
