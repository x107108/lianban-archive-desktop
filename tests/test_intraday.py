"""Wrong dates, partial sessions, cumulative volumes, offline reads and retries."""
from contextlib import closing
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

import app
import database as db
import intraday as minute
import intraday_sources as sources
import provider
from collect_intraday import collect, fetch_stock


def event(day="2026-10-21"):
    return {"date": day, "code": "600001", "name": "分时测试", "boards": 1, "close": 11, "pct_change": 10}


def complete_points():
    clocks = [f"{total // 60:02}:{total % 60:02}" for total in [*range(570, 691), *range(781, 901)]]
    return [{"time": clock, "price": 11, "average": 10.5, "volume": 100, "amount": 1100} for clock in clocks]


class IntradayTests(unittest.TestCase):
    def setUp(self):
        # Retain test files rather than doing automatic bulk deletion.
        self.root = Path(__file__).parent / "test-data" / ("intraday-" + uuid4().hex)
        self.root.mkdir(parents=True)
        self.path = self.root / "archive.sqlite3"
        with closing(db.connect(self.path)) as conn:
            db.save_day(conn, "2026-10-21", [event()], "synthetic")
            db.save_day(conn, "2026-10-20", [event("2026-10-20")], "synthetic")

    def test_read_routes_are_offline_and_do_not_create_a_minute_database(self):
        with patch("requests.get", side_effect=AssertionError("no network on read")):
            result = app.read_api(SimpleNamespace(db_path=self.path), "/api/intraday?date=2026-10-21")
            self.assertEqual((result["total"], result["missing"]), (1, 1))
            self.assertFalse(minute.store_path(self.path).exists())
            detail = app.read_api(SimpleNamespace(db_path=self.path), "/api/intraday/stock?date=2026-10-21&code=600001")
            self.assertEqual((detail["status"], detail["points"]), ("missing", []))
            self.assertFalse(minute.store_path(self.path).exists())

    def test_complete_partial_duplicate_nan_and_closing_price_checks(self):
        self.assertEqual(minute.validate_points(complete_points(), event())[0], "ok")
        self.assertEqual(minute.validate_points(complete_points()[1:], event())[0], "partial")
        for field, value in (("price", float("nan")), ("volume", -1), ("amount", float("inf")), ("time", "15:30")):
            with self.subTest(field=field):
                points = complete_points()
                points[5][field] = value
                with self.assertRaises(ValueError):
                    minute.validate_points(points, event())
        duplicate = complete_points()
        duplicate.insert(4, deepcopy(duplicate[3]))
        with self.assertRaises(ValueError):
            minute.validate_points(duplicate, event())
        mismatch = complete_points()
        mismatch[-1]["price"] = 12
        with self.assertRaisesRegex(ValueError, "收盘价"):
            minute.validate_points(mismatch, event())

    def test_eastmoney_dates_units_and_per_day_previous_close(self):
        payload = {"rc": 0, "data": {"code": "600001", "preClose": 99, "trends": [
            "2026-10-20 15:00,0,12,12,12,7,8400,12",
            "2026-10-21 15:00,11,11,11,11,3,3300,11",
        ]}}
        points = minute.normalize_eastmoney(payload, event())
        self.assertEqual(len(points), 1)
        self.assertEqual((points[0]["time"], points[0]["volume"]), ("15:00", 300))
        self.assertEqual(minute.previous_close(event()), 10)
        wrong = deepcopy(payload)
        wrong["data"]["code"] = "600002"
        with self.assertRaises(ValueError):
            minute.normalize_eastmoney(wrong, event())
        with self.assertRaises(ValueError):
            minute.normalize_eastmoney(None, event())

    def test_tencent_cumulative_differences_and_after_hours_exclusion(self):
        payload = {"code": 0, "data": {"sh600001": {"data": [{"date": "20261021", "data": [
            "0930 10 2 2000", "0931 11 5 5300", "1500 11 8 8600", "1530 11 9 9700"]}]}}}
        points = minute.normalize_tencent(payload, event())
        self.assertEqual([p["volume"] for p in points], [200, 300, 300])
        self.assertEqual([p["amount"] for p in points], [2000, 3300, 3300])
        self.assertAlmostEqual(points[1]["average"], 10.6)
        with self.assertRaises(ValueError):
            minute.normalize_tencent(payload, event("2026-10-20"))
        payload["data"]["sh600001"]["data"][0]["data"][1] = "0931 11 1 1000"
        with self.assertRaises(ValueError):
            minute.normalize_tencent(payload, event())

    def test_failed_or_partial_retry_preserves_a_complete_session_and_archive(self):
        with closing(db.connect(self.path)) as conn:
            before = [tuple(r) for r in conn.execute("SELECT * FROM events ORDER BY date")]
        with closing(minute.connect(minute.store_path(self.path))) as conn:
            minute.save_session(conn, event(), complete_points(), "synthetic", "test.json")
            self.assertFalse(minute.save_session(conn, event(), complete_points()[1:], "partial", "partial.json"))
            minute.save_error(conn, "2026-10-21", "600001", "temporary outage")
        with patch("requests.get", side_effect=AssertionError("offline")):
            detail = minute.stock_view(self.path, "2026-10-21", "600001")
            self.assertEqual((detail["status"], len(detail["points"])), ("ok", 241))
            summary = minute.overview(self.path)
            self.assertEqual((summary["date"], summary["ready"]), ("2026-10-21", 1))
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(before, [tuple(r) for r in conn.execute("SELECT * FROM events ORDER BY date")])

    def test_invalid_queries_and_non_pool_stock_are_rejected(self):
        for day, code in (("2026-02-30", "600001"), ("2026-10-21", "../x"), ("2026-10-21", "600002")):
            with self.subTest(day=day, code=code), self.assertRaises(ValueError):
                minute.stock_view(self.path, day, code)

    def test_calendar_includes_uncached_trading_days_without_collecting_them(self):
        sources.save_catalog(self.path, [{"code": "600001", "name": "分时测试"}], 1)
        with closing(db.connect(self.path)) as conn:
            db.set_settings(conn, calendar_dates=["2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2099-01-01"])
        with closing(minute.connect(minute.store_path(self.path))) as conn:
            minute.save_session(conn, event(), complete_points(), "synthetic", "cached.json")
        with patch("requests.get", side_effect=AssertionError("calendar browsing must stay offline")), patch.object(minute, "_cached", wraps=minute._cached) as cached:
            result = minute.overview(self.path, "2026-10-19")
        self.assertEqual(result["dates"], ["2026-10-21", "2026-10-20", "2026-10-19", "2026-10-16"])
        self.assertEqual((result["date"], result["ready"], result["missing"]), ("2026-10-19", 0, 1))
        cached.assert_called_once_with(self.path, day="2026-10-19")
        with closing(minute.connect(minute.store_path(self.path))) as conn:
            self.assertEqual([r[0] for r in conn.execute("SELECT DISTINCT date FROM sessions")], ["2026-10-21"])

    def test_non_trading_and_future_dates_do_not_start_collection(self):
        with patch.object(sources, "fetch_json", side_effect=AssertionError("must not collect a non-trading date")) as fetch:
            for day in ("2026-10-18", "2099-01-01"):
                with self.subTest(day=day), self.assertRaisesRegex(ValueError, "交易日历"):
                    minute.overview(self.path, day)
                with self.subTest(day=day), self.assertRaisesRegex(ValueError, "交易日历"):
                    sources.collect_requested(self.path, day, "600001")
            fetch.assert_not_called()
        self.assertFalse(minute.store_path(self.path).exists())

    def test_unavailable_historical_date_reports_actual_source_window(self):
        payload = {"code": 0, "data": {"sh600001": {"data": [
            {"date": "20261020", "data": ["1500 11 1 1100"]},
            {"date": "20261021", "data": ["1500 11 1 1100"]}]}}}
        with self.assertRaisesRegex(ValueError, "未提供 2026-10-19.*2026-10-20 至 2026-10-21"):
            minute.normalize_tencent(payload, event("2026-10-19"))

    def test_current_profile_matches_daily_search_without_recollecting_minutes(self):
        with closing(db.connect(self.path)) as conn:
            db.save_stock_tags(conn, "600001", ["标签甲", "<行业>"], 0)
            db.save_stock_note(conn, "600001", "独立备注\n第二行", 0)
            db.save_blacklist(conn, "600001", "add")
            with conn:
                conn.execute("INSERT INTO company_registrations VALUES (?,?,?,?,?,?,?)",
                             ("600001", "浙江省", "", "", "", "synthetic", db.now_iso()))
            expected = db.date_view(conn, "2026-10-21")["rows"][0]
        for actual in (minute.overview(self.path, "2026-10-21")["rows"][0],
                       minute.stock_view(self.path, "2026-10-21", "600001")["stock"]):
            for field in ("tags", "note", "initials", "registered_province"):
                self.assertEqual(actual[field], expected[field])
        self.assertTrue(minute.stock_view(self.path, "2026-10-21", "600001")["stock"]["blacklisted"])
        self.assertFalse(minute.store_path(self.path).exists())

    def test_collector_skips_complete_data_without_upstream_calls(self):
        with closing(minute.connect(minute.store_path(self.path))) as conn:
            minute.save_session(conn, event(), complete_points(), "synthetic", "test.json")
        sources.save_catalog(self.path, [{"code": "600001", "name": "分时测试"}, {"code": "000001", "name": "非涨停股"}], 2)
        with patch("collect_intraday.fetch_stock", side_effect=AssertionError("must skip")):
            report = collect(self.path, ["2026-10-21"])
        self.assertEqual(report["days"][0]["ready"], 1)
        self.assertEqual(report["days"][0]["total"], 1, "the legacy collector report covers its pool, not the whole main-board directory")

    def test_failed_primary_uses_secondary_and_filters_unrequested_dates(self):
        import requests
        raw_dir = self.root / "raw"
        raw_dir.mkdir()
        bars = [f"{p['time'].replace(':', '')} 11 {i + 1} {(i + 1) * 1100}" for i, p in enumerate(complete_points())]
        payload = {"code": 0, "data": {"sh600001": {"data": [{"date": "20261021", "data": bars}]}}}
        response = SimpleNamespace(content=b"{}", raise_for_status=lambda: None, json=lambda: payload)
        with patch("requests.get", side_effect=[requests.ConnectionError(), requests.ConnectionError(), response]), patch("collect_intraday.time.sleep"):
            results, failures = fetch_stock([event(), event("2026-10-20")], raw_dir)
        self.assertEqual((len(results), results[0][0]["date"], results[0][2]), (1, "2026-10-21", "腾讯财经分时"))
        self.assertEqual({e["date"] for e, _ in failures}, {"2026-10-20"})

    def test_mainboard_directory_adds_non_limit_stocks_without_inventing_events(self):
        sources.save_catalog(self.path, [{"code": "600001", "name": "分时测试"}, {"code": "000001", "name": "非涨停股"}], 2)
        overview = minute.overview(self.path, "2026-10-21")
        self.assertEqual(overview["total"], 2)
        self.assertTrue(overview["catalog_complete"])
        stock = minute.stock_view(self.path, "2026-10-21", "000001")
        self.assertEqual(stock["stock"]["boards"], 0)
        self.assertEqual(stock["status"], "missing")
        self.assertTrue(stock["needs_collection"])
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], 2)
        with self.assertRaises(ValueError):
            sources.save_catalog(self.path, [{"code": "300001", "name": "创业板"}], 1)
        with self.assertRaises(ValueError):
            sources.save_catalog(self.path, [{"code": "000001", "name": "缺页"}], 2)
        self.assertEqual(len(minute.catalog(self.path)), 2)

    def test_selected_day_broken_pool_is_cached_and_never_changes_closing_boards(self):
        sources.save_catalog(self.path, [{"code": "600001", "name": "分时测试"}, {"code": "000001", "name": "破板测试"}], 2)
        stamp = lambda clock: int(datetime.fromisoformat(f"2026-10-21T{clock}+08:00").timestamp())
        raw = {"symbol": "000001.SZ", "stock_chi_name": "破板测试", "price": 10.5, "change_percent": .05,
               "limit_up_days": 0, "first_limit_up": stamp("09:40:01"), "last_limit_up": stamp("09:40:01"),
               "last_break_limit_up": stamp("09:41:05"), "break_limit_up_times": 1}
        payload = {"code": 20000, "data": [raw, {**raw, "symbol": "600001.SS"},
                    {**raw, "symbol": "000002.SZ", "stock_chi_name": "*ST测试"}, {**raw, "symbol": "300001.SZ"}]}
        with patch.object(sources, "fetch_json", return_value=(payload, "synthetic.json")) as fetch:
            overview = sources.collect_broken_pool(self.path, "2026-10-21")
            self.assertEqual(fetch.call_args.args[1], {"pool_name": "limit_up_broken", "date": "2026-10-21"})
            sources.collect_broken_pool(self.path, "2026-10-21")
            self.assertEqual(fetch.call_count, 1, "confirmed historical metadata is reused without fetching more dates or minute data")
        rows = {r["code"]: r for r in overview["rows"]}
        self.assertEqual((rows["000001"]["stock_type"], rows["000001"]["boards"], rows["000001"]["status"]), ("broken", 0, "missing"))
        self.assertEqual((rows["600001"]["stock_type"], rows["600001"]["boards"]), ("limit_up", 1), "a confirmed close supersedes a broken snapshot")
        self.assertFalse(overview["broken_pool"]["needs_collection"])
        self.assertTrue(minute.broken_pool_view(self.path, "2026-10-20")["needs_collection"])
        with patch("requests.get", side_effect=AssertionError("GET must stay offline")):
            detail = app.read_api(SimpleNamespace(db_path=self.path), "/api/intraday/stock?date=2026-10-21&code=000001")
            app.read_api(SimpleNamespace(db_path=self.path), "/api/intraday?date=2026-10-21")
        self.assertEqual((detail["stock"]["stock_type"], detail["stock"]["first_time"]), ("broken", "09:40:01"))
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], 2)

    def test_broken_pool_rejects_wrong_days_sealed_rows_and_empty_retries(self):
        sources.save_catalog(self.path, [{"code": "000001", "name": "破板测试"}], 1)
        stamp = int(datetime.fromisoformat("2026-10-21T09:40:01+08:00").timestamp())
        raw = {"symbol": "000001.SZ", "stock_chi_name": "破板测试", "price": 10.5, "change_percent": .05,
               "limit_up_days": 0, "first_limit_up": stamp, "last_limit_up": stamp, "last_break_limit_up": stamp+60, "break_limit_up_times": 1}
        valid = {"code": 20000, "data": [raw]}
        with patch.object(sources, "fetch_json", return_value=(valid, "valid.json")):
            sources.collect_broken_pool(self.path, "2026-10-21")
        cached = minute.broken_pool_view(self.path, "2026-10-21")
        for invalid in ({"code": 20000, "data": []}, {"code": 20000, "data": [{**raw, "first_limit_up": stamp-86400}]},
                        {"code": 20000, "data": [{**raw, "limit_up_days": 1}]}, {"code": 20000, "data": [raw, raw]}):
            with patch("live_pool.minute_refresh_due", return_value=True), patch.object(sources, "fetch_json", return_value=(invalid, "bad.json")):
                with self.assertRaises((ValueError, provider.ProviderError)):
                    sources.collect_broken_pool(self.path, "2026-10-21")
            self.assertEqual(minute.broken_pool_view(self.path, "2026-10-21"), cached, "invalid metadata cannot replace a verified day")

    def test_st_is_excluded_from_lists_totals_cached_details_and_on_demand_collection(self):
        rows = [event(), {**event(), "code": "600002", "name": "历史普通股"},
                {**event(), "code": "600003", "name": " *st 测试 "}]
        with closing(db.connect(self.path)) as conn:
            db.save_day(conn, "2026-10-21", rows, "synthetic")
        sources.save_catalog(self.path, [{"code": "600001", "name": "分时测试"},
                                        {"code": "600002", "name": "ST当前股"},
                                        {"code": "600003", "name": "当前普通股"},
                                        {"code": "000002", "name": "*ST目录股"}], 4)
        with closing(minute.connect(minute.store_path(self.path))) as conn:
            for row in rows:
                minute.save_session(conn, row, complete_points(), "synthetic", "cached.json")
        overview = minute.overview(self.path, "2026-10-21")
        self.assertEqual([row["code"] for row in overview["rows"]], ["600001"])
        self.assertEqual((overview["total"], overview["ready"], overview["missing"]), (1, 1, 0))
        with patch.object(sources, "fetch_json", side_effect=AssertionError("ST must not be collected")) as fetch:
            for code in ("600002", "600003", "000002"):
                with self.subTest(code=code), self.assertRaisesRegex(ValueError, "已剔除 ST"):
                    minute.stock_view(self.path, "2026-10-21", code)
                with self.subTest(code=code), self.assertRaisesRegex(ValueError, "已剔除 ST"):
                    sources.collect_requested(self.path, "2026-10-21", code, force=True)
            fetch.assert_not_called()
        with closing(minute.connect(minute.store_path(self.path))) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 3)
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM events WHERE date='2026-10-21'").fetchone()[0], 3)

    def test_st_is_also_excluded_before_the_mainboard_catalog_is_synced(self):
        with closing(db.connect(self.path)) as conn:
            db.save_day(conn, "2026-10-21", [event(), {**event(), "code": "600002", "name": "ST测试"}], "synthetic")
        self.assertEqual([r["code"] for r in minute.overview(self.path, "2026-10-21")["rows"]], ["600001"])
        with self.assertRaisesRegex(ValueError, "已剔除 ST"):
            minute.stock_view(self.path, "2026-10-21", "600002")

    def test_batch_collection_skips_st_by_current_and_selected_day_names(self):
        with closing(db.connect(self.path)) as conn:
            db.save_day(conn, "2026-10-21", [event(), {**event(), "code": "600002", "name": "*ST当日"},
                        {**event(), "code": "600003", "name": "历史普通股"}], "synthetic")
        sources.save_catalog(self.path, [{"code": "600001", "name": "分时测试"},
                                        {"code": "600002", "name": "当前普通股"},
                                        {"code": "600003", "name": " st 当前股"}], 3)
        with patch("collect_intraday.fetch_stock", return_value=([], [])) as fetch:
            report = collect(self.path, ["2026-10-21"], force=True)
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual([r["code"] for r in fetch.call_args.args[0]], ["600001"])
        self.assertEqual(report["days"][0]["total"], 1)

    def test_auction_is_independent_date_checked_match_and_never_copies_0930(self):
        payload = [{"symbol": "sh600001", "ticktime": "09:25:00", "price": "11", "volume": "100"}]
        points = complete_points()
        self.assertEqual(sources.normalize_auction(payload, "sh600001", points)[0]["volume"], 100)
        self.assertEqual(sources.normalize_auction([], "sh600001", points), [])
        payload[0]["price"] = "12"
        with self.assertRaises(ValueError):
            sources.normalize_auction(payload, "sh600001", points)
        payload[0]["price"], payload[0]["volume"] = "11", "10000"
        with self.assertRaises(ValueError):
            sources.normalize_auction(payload, "sh600001", points)

    def test_on_demand_collection_caches_non_limit_stocks_and_reference(self):
        sources.save_catalog(self.path, [{"code": "600001", "name": "分时测试"}, {"code": "000001", "name": "非涨停股"}], 2)
        bars = [f"{p['time'].replace(':', '')} 11 {i + 1} {(i + 1) * 1100}" for i, p in enumerate(complete_points())]
        payload = {"code": 0, "data": {"sz000001": {"data": [{"date": "20261021", "data": bars}, {"date": "20261020", "data": ["1500 10 100 100000"]}]}}}
        auction = [{"symbol": "sz000001", "ticktime": "09:25:00", "price": "11", "volume": "100"}]
        with patch.object(sources, "fetch_json", side_effect=[(payload, "minute.json"), (auction, "auction.json")]) as fetch:
            detail = sources.collect_requested(self.path, "2026-10-21", "000001")
            self.assertEqual(fetch.call_count, 2)
        self.assertEqual((detail["status"], detail["previous_close"], len(detail["points"])), ("ok", 10, 241))
        self.assertEqual(detail["auction"]["status"], "match_only")
        self.assertIn("未校正除权", detail["reference_basis"])
        with patch.object(sources, "fetch_json", side_effect=AssertionError("cached reads must stay offline")):
            self.assertEqual(sources.collect_requested(self.path, "2026-10-21", "000001")["status"], "ok")
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM events WHERE code='000001'").fetchone()[0], 0)
        with closing(minute.connect(minute.store_path(self.path))) as conn:
            self.assertEqual([r[0] for r in conn.execute("SELECT DISTINCT date FROM sessions")], ["2026-10-21"], "other dates in an upstream response are not written to the cache")

    def test_failed_auction_does_not_destroy_complete_minutes(self):
        with closing(minute.connect(minute.store_path(self.path))) as conn:
            minute.save_session(conn, event(), complete_points(), "synthetic", "existing.json")
        with patch.object(sources, "fetch_json", side_effect=ValueError("unavailable")):
            detail = sources.collect_requested(self.path, "2026-10-21", "600001")
        self.assertEqual((detail["status"], len(detail["points"])), ("ok", 241))
        self.assertEqual(detail["auction"]["points"], [])
        self.assertEqual(detail["auction"]["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
