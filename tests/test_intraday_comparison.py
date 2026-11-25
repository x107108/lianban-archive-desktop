"""Dated real-cache reads, ST/GEM flags, volume units and no invented minutes."""
from contextlib import closing
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

import app
import database as db
import intraday
import intraday_comparison
import intraday_sources as sources


def event(code="600001", name="真实测试", boards=2, day="2026-11-11"):
    return {"date": day, "code": code, "name": name, "boards": boards, "close": 11, "pct_change": 10}


class IntradayComparisonTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).parent / "test-data" / ("comparison-" + uuid4().hex)
        self.root.mkdir(parents=True)
        self.path = self.root / "archive.sqlite3"
        with closing(db.connect(self.path)) as conn:
            db.save_day(conn, "2026-11-10", [event(day="2026-11-10", boards=3), event("600002", "*ST样本", 2, "2026-11-10"), event("300001", "创业样本", 2, "2026-11-10")], "test")
            db.save_day(conn, "2026-11-11", [event(), event("600002", "*ST样本"), event("300001", "创业样本"), event("600003", "首板样本", 1)], "test")
            db.save_day(conn, "2026-11-12", [event(name="ST未来名称", day="2026-11-12")], "test")
        self.points = [{"time": time, "price": price, "volume": volume, "amount": price * volume, "average": price}
                       for time, price, volume in [("09:30", 10.5, 1000), ("11:30", 10.8, 2000), ("13:00", 10.9, 3000), ("15:00", 11, 4000)]]

    def cache(self):
        with closing(intraday.connect(intraday.store_path(self.path))) as conn:
            for row in [event(), event("600002", "*ST样本"), event("300001", "创业样本")]:
                intraday.save_session(conn, row, [dict(point) for point in self.points], "可核验来源", "private/raw.json")
            auction = [{"time": "09:25", "price": 10.5, "volume": 400, "amount": 4200}]
            with conn:
                conn.execute("INSERT INTO auctions VALUES (?,?,?,?,?,?,?,?)", ("2026-11-11", "600001", "match_only", json.dumps(auction), "", "test", db.now_iso(), "private/auction.json"))

    def test_matched_stock_outside_mainboard_uses_dated_cached_detail(self):
        self.cache()
        day = "2026-11-11"
        # A non-limit-up GEM match may have been collected by comparison alone.
        code = "300002"
        with closing(intraday.connect(intraday.store_path(self.path))) as conn:
            intraday.save_session(conn, {**event(code, "创业对比", 0), "market": db.market_for(code)},
                                  self.points, "test", "test/raw.json")
        server = SimpleNamespace(db_path=self.path, read_only=True)
        overview = app.read_api(server, f"/api/intraday?date={day}")
        self.assertFalse({"600002", "300001", code} & {row["code"] for row in overview["rows"]})
        for match_code in ("600002", "300001", code):
            detail = app.read_api(server, f"/api/intraday/stock?date={day}&code={match_code}&cached_match=1")
            self.assertEqual(detail["date"], day)
            self.assertEqual(detail["stock"]["code"], match_code)
            self.assertEqual(detail["points"], self.points)
            self.assertFalse(detail["needs_collection"])
            self.assertFalse(detail["needs_refresh"])
        with self.assertRaisesRegex(ValueError, "匹配分时已不可用"):
            app.read_api(server, f"/api/intraday/stock?date={day}&code=600003&cached_match=1")

    def test_read_is_offline_and_does_not_create_a_cache(self):
        with patch("requests.get", side_effect=AssertionError("read must stay offline")):
            result = app.read_api(SimpleNamespace(db_path=self.path, read_only=True), "/api/intraday/comparison?date=2026-11-11")
        self.assertEqual(result["cached"], 0)
        self.assertTrue(all(not row["points"] for row in result["rows"]))
        self.assertFalse(intraday.store_path(self.path).exists())

    def test_real_prices_dates_previous_identity_units_and_missing_minutes(self):
        self.cache()
        result = intraday_comparison.view(self.path, "2026-11-11")
        rows = {row["code"]: row for row in result["rows"]}
        row = rows["600001"]
        self.assertEqual((result["date"], result["previous_date"], result["cached"]), ("2026-11-11", "2026-11-10", 3))
        self.assertEqual((row["name"], row["yesterday"], row["previous_close"]), ("真实测试", 3, 10))
        self.assertEqual(row["boards"], 2)
        self.assertTrue(result["pool_known"])
        self.assertFalse(row["is_st"], "future ST renaming cannot override the cached selected-day identity")
        self.assertEqual([point[0] for point in row["points"]], ["09:30", "11:30", "13:00", "15:00"])
        self.assertEqual(row["points"][0], ["09:30", 10.5, 6], "subtract verified auction volume and convert shares to hands")
        self.assertEqual(row["points"][2], ["13:00", 10.9, 30])
        self.assertEqual(rows["600003"]["points"], [])
        self.assertEqual(rows["600003"]["yesterday"], 0)
        self.assertNotIn("raw_path", json.dumps(result))
        self.assertNotIn("private/", json.dumps(result))

    def test_st_and_gem_are_returned_for_working_client_side_filters(self):
        self.cache()
        result = app.read_api(SimpleNamespace(db_path=self.path), "/api/intraday/comparison?date=2026-11-11")
        rows = {row["code"]: row for row in result["rows"]}
        self.assertTrue(rows["600002"]["is_st"])
        self.assertTrue(rows["300001"]["is_gem"])
        self.assertTrue(rows["300001"]["points"])
        self.assertTrue(rows["600002"]["initials"])

    def test_comparison_profile_uses_stock_detail_fields(self):
        self.cache()
        code, day = "600001", "2026-11-11"
        with closing(db.connect(self.path)) as conn:
            db.save_registrations(conn, [{"code": code, "province": "山西省"}], "test", db.now_iso(), [], 1)
            db.save_stock_tags(conn, code, ["自定义标签"], 0)
            db.save_blacklist(conn, code, "add")
            db.save_stock_note(conn, code, "复盘备注", 0, new_entry=True)
            detail = db.stock_view(conn, code, "2026-11-10", day)["stock"]
        server = SimpleNamespace(db_path=self.path, read_only=False)
        result = app.read_api(server, f"/api/intraday/comparison?date={day}")
        row = next(row for row in result["rows"] if row["code"] == code)
        for field in ["tags", "registered_province", "blacklisted", "note"]:
            self.assertEqual(row[field], detail[field])
        server.read_only = True
        result = app.read_api(server, f"/api/intraday/comparison?date={day}")
        row = next(row for row in result["rows"] if row["code"] == code)
        self.assertNotIn("note", row)
        self.assertNotIn("blacklisted", row)

    def test_selected_day_boards_override_previous_day_and_cached_context(self):
        self.cache()
        with closing(db.connect(self.path)) as conn:
            db.save_day(conn, "2026-11-11", [event(boards=1)], "test")
        row = next(row for row in intraday_comparison.view(self.path, "2026-11-11")["rows"] if row["code"] == "600001")
        self.assertEqual((row["boards"], row["yesterday"]), (1, 3))

    def test_price_axis_limits_use_dated_rules_and_cent_rounding(self):
        cases = [("2026-11-11", "000533", "顺钠股份", 9.82, 8.84, 10.80),
                 ("2026-11-11", "600004", "半分进位", 10.05, 9.05, 11.06),
                 ("2026-11-11", "300001", "ST创业样本", 10.03, 8.02, 12.04),
                 ("2026-07-03", "600002", "ST样本", 10.10, 9.60, 10.61),
                 ("2026-07-06", "600002", "ST样本", 10.10, 9.09, 11.11)]
        with closing(db.connect(self.path)) as conn:
            db.set_settings(conn, calendar_dates=["2026-07-03", "2026-07-06", "2026-11-11"])
        with closing(intraday.connect(intraday.store_path(self.path))) as conn:
            for day, code, name, previous, lower, upper in cases:
                stock = {**event(code, name, day=day), "previous_close": previous, "close": upper}
                points = [{"time": "09:30", "price": lower, "volume": 100, "amount": lower * 100},
                          {"time": "15:00", "price": upper, "volume": 200, "amount": upper * 200}]
                intraday.save_session(conn, stock, points, "test", "test/raw.json")
        for day, code, name, previous, lower, upper in cases:
            with self.subTest(day=day, code=code):
                row = next(row for row in intraday_comparison.view(self.path, day)["rows"] if row["code"] == code)
                self.assertEqual((row["previous_close"], row["limit_down_price"], row["limit_up_price"]), (previous, lower, upper))
                self.assertEqual([point[1] for point in row["points"]], [lower, upper], "axis changes cannot alter real prices")

    def test_missing_selected_day_pool_is_not_classified_from_old_names(self):
        with closing(db.connect(self.path)) as conn:
            db.set_settings(conn, calendar_dates=["2026-11-13"])
        result = intraday_comparison.view(self.path, "2026-11-13")
        self.assertFalse(result["pool_known"])
        self.assertTrue(all(row["boards"] is None for row in result["rows"]))

    def test_previous_pool_unavailable_is_unknown_not_nonconsecutive(self):
        with closing(db.connect(self.path)) as conn:
            db.set_settings(conn, calendar_dates=["2026-11-09", "2026-11-10", "2026-11-11"])
        result = intraday_comparison.view(self.path, "2026-11-10")
        self.assertFalse(result["identity_known"])
        self.assertTrue(all(row["yesterday"] is None for row in result["rows"]))

    def test_invalid_or_nontrading_dates_are_rejected(self):
        for day in ["2026-11-14", "2026-13-01", "not-a-date"]:
            with self.subTest(day=day), self.assertRaises(ValueError):
                app.read_api(SimpleNamespace(db_path=self.path), "/api/intraday/comparison?date=" + day)

    def test_collects_non_limit_up_st_and_gem_with_the_selected_date_only(self):
        sources.save_catalog(self.path, [{"code": "000001", "name": "普通非涨停"}], 1)
        clocks = [*range(570, 691), *range(780, 901)]
        bars = [f"{minute // 60:02}{minute % 60:02} 10.5 {i + 1} {(i + 1) * 1050}" for i, minute in enumerate(clocks)]
        for code in ["000001", "600002", "300001"]:
            with self.subTest(code=code):
                symbol = ("sh" if code.startswith("6") else "sz") + code
                payload = {"code": 0, "data": {symbol: {"data": [
                    {"date": "20261111", "data": bars}, {"date": "20261110", "data": ["1500 10 100 100000"]}]}}}
                with patch.object(sources, "fetch_json", return_value=(payload, "test/raw.json")) as fetch:
                    result = intraday_comparison.collect(self.path, "2026-11-11", code)
                row, = result["rows"]
                self.assertEqual(fetch.call_count, 1, "comparison fills minutes without an extra auction request per candidate")
                self.assertEqual((row["code"], row["previous_close"], row["status"], len(row["points"])), (code, 10, "ok", 242))
                self.assertEqual(row["boards"], 0 if code == "000001" else 2)
                with patch.object(sources, "fetch_json", side_effect=AssertionError("completed dates are reused")):
                    self.assertEqual(intraday_comparison.collect(self.path, "2026-11-11", code)["rows"][0]["status"], "ok")
        with closing(intraday.connect(intraday.store_path(self.path))) as conn:
            self.assertEqual([row[0] for row in conn.execute("SELECT DISTINCT date FROM sessions")], ["2026-11-11"])
        with closing(db.connect(self.path)) as conn:
            self.assertFalse(conn.execute("SELECT 1 FROM events WHERE code='000001'").fetchone(), "ordinary stocks are not added to the limit-up pool")

    def test_collection_rejects_wrong_dates_and_unknown_codes_without_inventing_data(self):
        payload = {"code": 0, "data": {"sh600001": {"data": [{"date": "20261112", "data": ["1500 11 100 110000"]}]}}}
        with patch.object(sources, "fetch_json", return_value=(payload, "test/raw.json")):
            with self.assertRaises(ValueError):
                intraday_comparison.collect(self.path, "2026-11-11", "600001")
        self.assertEqual(intraday_comparison.view(self.path, "2026-11-11", code="600001")["rows"][0]["points"], [])
        with patch.object(sources, "fetch_json", side_effect=AssertionError("invalid inputs never reach the source")):
            for day, code in [("2026-11-11", "999999"), ("2026-11-11", "600999"), ("2026-11-14", "600001")]:
                with self.subTest(day=day, code=code), self.assertRaises(ValueError):
                    intraday_comparison.collect(self.path, day, code)

    def test_read_only_site_cannot_start_comparison_collection(self):
        handler = SimpleNamespace(path="/api/intraday/comparison/collect", server=SimpleNamespace(read_only=True), reply=Mock())
        with patch.object(intraday_comparison, "collect") as collect:
            app.Handler.do_POST(handler)
        handler.reply.assert_called_once_with({"error": "公开版本仅供查询"}, 403)
        collect.assert_not_called()
