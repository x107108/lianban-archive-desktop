"""Archive correctness tests. All records here are synthetic test fixtures."""
from __future__ import annotations

import io
import json
import sqlite3
import sys
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app
import database as db
import provider


def event(code="000001", name="测试甲", boards=1, **fields):
    return {"code": code, "name": name, "boards": boards, **fields}


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.set_settings(self.conn, range_start="2025-10-14", range_end="2025-10-31")

    def tearDown(self):
        self.conn.close()

    def save(self, day, records, **kwargs):
        return db.save_day(self.conn, day, records, "synthetic-test", **kwargs)

    def test_failed_retry_preserves_confirmed_snapshot(self):
        self.save("2025-10-14", [event(boards=2)])
        self.assertFalse(self.save("2025-10-14", [], status="failed", note="模拟超时"))
        result = db.date_view(self.conn, "2025-10-14")
        self.assertEqual(result["data_status"], "ok")
        self.assertEqual(result["rows"][0]["boards"], 2)
        self.assertEqual(db.meta(self.conn)["coverage"]["records"], 1)

    def test_corrected_snapshot_removes_withdrawn_observation(self):
        self.save("2025-10-14", [event(), event("600001", "测试乙")])
        self.save("2025-10-14", [event("600001", "测试乙", boards=2)])
        result = db.date_view(self.conn, "2025-10-14")
        self.assertEqual([r["code"] for r in result["rows"]], ["600001"])
        self.assertEqual(self.conn.execute("SELECT count FROM days").fetchone()[0], 1)
        self.assertEqual(db.meta(self.conn)["coverage"]["records"], 1)

    def test_duplicate_replacement_is_atomic(self):
        self.save("2025-10-14", [event(boards=2)])
        with self.assertRaises(ValueError):
            self.save("2025-10-14", [event("600001"), event("600001", boards=3)])
        self.assertEqual(db.date_view(self.conn, "2025-10-14")["rows"][0]["code"], "000001")
        self.assertEqual(db.date_view(self.conn, "2025-10-14")["rows"][0]["boards"], 2)

    def test_mismatched_returned_date_cannot_enter_archive(self):
        with self.assertRaises(ValueError):
            self.save("2025-10-14", [event(date="2025-10-15")])
        self.assertEqual(db.meta(self.conn)["coverage"]["records"], 0)

    def test_invalid_code_cannot_enter_archive(self):
        for code in ("00001", "000001.SZ", "０００００１", "abc123"):
            with self.subTest(code=code), self.assertRaises(ValueError):
                self.save("2025-10-14", [event(code)])

    def test_fractional_board_count_is_rejected_not_truncated(self):
        with self.assertRaises(ValueError):
            self.save("2025-10-14", [event(boards=2.5)])

    def test_unconfirmed_records_are_not_presented_as_observations(self):
        try:
            self.save("2025-10-14", [event()], status="unknown")
        except ValueError:
            pass  # Rejecting inconsistent inputs is also a valid contract.
        self.assertEqual(db.date_view(self.conn, "2025-10-14")["rows"], [])
        self.assertEqual(db.meta(self.conn)["coverage"]["records"], 0)

    def test_stock_search_matches_past_name_and_returns_latest_name(self):
        self.save("2025-10-16", [event(name="新名称")])
        self.save("2025-10-14", [event(name="旧名称")])
        found = db.search_stocks(self.conn, "旧名称")["rows"]
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["name"], "新名称")
        self.assertEqual(db.date_view(self.conn, "2025-10-14")["rows"][0]["name"], "旧名称")

    def test_stock_search_supports_case_insensitive_initials_and_prior_names(self):
        self.save("2025-10-14", [event("600802", "福建水泥"), event("600803", "福建水泥发展"),
                                 event("600804", "重庆银行"), event("600805", "*ST金科")])
        for query in ("FJSN", "fjsn", " f j s n "):
            rows = db.search_stocks(self.conn, query)["rows"]
            self.assertEqual(rows[0]["code"], "600802")
            self.assertEqual(rows[0]["initials"], "FJSN")
        self.assertEqual(db.search_stocks(self.conn, "CQYH")["rows"][0]["name"], "重庆银行")
        self.assertEqual(db.search_stocks(self.conn, "JK")["rows"][0]["name"], "*ST金科")
        self.save("2025-10-15", [event("600802", "测试新名")])
        self.assertEqual(db.search_stocks(self.conn, "FJSN")["rows"][0]["name"], "测试新名")
        self.assertEqual(db.date_view(self.conn, "2025-10-14")["rows"][0]["name"], "福建水泥")

    def test_daily_initials_follow_the_historical_name_and_preserve_facts(self):
        self.save("2025-10-14", [event("600802", "福建水泥"), event("000573", "粤宏远Ａ")])
        self.save("2025-10-15", [event("600802", "测试新名")])
        before = [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")]
        old = db.date_view(self.conn, "2025-10-14")
        initials = {row["code"]:row["initials"] for row in old["rows"]}
        self.assertEqual(initials, {"600802":"FJSN", "000573":"YHYA"})
        self.assertEqual(db.date_view(self.conn, "2025-10-15")["rows"][0]["initials"], "CSXM")
        self.assertEqual(old["stats"]["total"], 2)
        self.assertEqual(before, [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")])

    def test_date_filters_and_statistics_use_same_rows(self):
        self.save("2025-10-14", [
            event("000001", boards=1),
            event("600001", "上海测试", boards=4),
            event("300001", "创业测试", boards=3),
        ])
        result = db.date_view(self.conn, "2025-10-14", min_boards=2, market="沪市主板", query="上海")
        self.assertEqual([r["code"] for r in result["rows"]], ["600001"])
        self.assertEqual(result["stats"], {"total": 1, "consecutive": 1, "max_boards": 4, "first_boards": 0})
        self.assertEqual(result["groups"], [{"boards": 4, "count": 1}])

    def test_st_filter_uses_historical_event_name_after_name_changes(self):
        self.save("2025-10-14", [event("000001", "ST旧名称", boards=2),
                                 event("600001", "历史普通股", boards=3),
                                 event("000002", "*ST旧名称", boards=4)])
        self.save("2025-10-15", [event("000001", "摘帽新名称", boards=3),
                                 event("600001", "ST新名称", boards=4)])
        historical = db.date_view(self.conn, "2025-10-14", exclude_st=True)
        current = db.date_view(self.conn, "2025-10-15", exclude_st=True)
        self.assertEqual([row["code"] for row in historical["rows"]], ["600001"])
        self.assertEqual([row["code"] for row in current["rows"]], ["000001"])
        self.assertEqual(historical["stats"]["total"], 1)
        self.assertEqual(len(db.date_view(self.conn, "2025-10-14")["rows"]), 3)

    def test_gem_exclusion_keeps_counts_tags_and_facts_consistent(self):
        self.save("2025-10-14", [event("000001", "普通深市", boards=1),
                                 event("600001", "ST普通沪市", boards=2),
                                 event("300001", "创业甲", boards=3, market="沪市主板"),
                                 event("301001", "创业乙", boards=4),
                                 event("688001", "科创测试", boards=2),
                                 event("920001", "北交测试", boards=1)])
        db.save_stock_tags(self.conn, "300001", ["创业专属"], 0)
        before = [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")]
        filtered = db.date_view(self.conn, "2025-10-14", exclude_gem=True)
        self.assertEqual({row["code"] for row in filtered["rows"]}, {"000001", "600001", "688001", "920001"})
        self.assertEqual(filtered["stats"], {"total": 4, "consecutive": 2, "max_boards": 2, "first_boards": 2})
        self.assertEqual(filtered["available_total"], 4)
        self.assertEqual(filtered["board_counts"], [{"boards": 1, "count": 2}, {"boards": 2, "count": 2}])
        self.assertNotIn("创业专属", filtered["tag_board_counts"])
        combined = db.date_view(self.conn, "2025-10-14", exclude_gem=True, exclude_st=True, boards=2)
        self.assertEqual([row["code"] for row in combined["rows"]], ["688001"])
        self.assertEqual(combined["available_total"], 3)
        self.assertEqual(combined["board_counts"], [{"boards": 1, "count": 2}, {"boards": 2, "count": 1}])
        self.assertEqual(db.date_view(self.conn, "2025-10-14", market="gem", exclude_gem=True)["rows"], [])
        self.assertEqual(len(db.date_view(self.conn, "2025-10-14")["rows"]), 6)
        self.assertEqual(before, [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")])

    def test_exact_board_selection_keeps_counts_for_the_other_board_chips(self):
        self.save("2025-10-14", [event("600001", "电力甲", boards=2),
                                 event("600002", "电力乙", boards=3),
                                 event("600003", "电力丙", boards=4),
                                 event("600004", "ST电力丁", boards=3),
                                 event("000005", "电力深市", boards=3),
                                 event("600006", "芯片股", boards=3)])
        result = db.date_view(self.conn, "2025-10-14", market="沪市主板", query="电力",
                              exclude_st=True, boards=3)
        self.assertEqual([row["code"] for row in result["rows"]], ["600002"])
        self.assertEqual(result["available_total"], 3)
        self.assertEqual(sorted((row["boards"], row["count"]) for row in result["board_counts"]),
                         [(2, 1), (3, 1), (4, 1)])
        self.assertEqual(result["groups"], [{"boards": 3, "count": 1}])
        self.assertEqual(result["stats"]["max_boards"], 3)

    def test_hide_st_matches_prefix_and_keeps_ordinary_names_containing_st(self):
        self.save("2025-10-14", [event("600001", "ST测试", boards=4),
                                 event("600002", "*ST测试", boards=3),
                                 event("600003", "st测试", boards=2),
                                 event("600004", "BEST科技", boards=1)])
        filtered = db.date_view(self.conn, "2025-10-14", exclude_st=True)
        self.assertEqual([row["code"] for row in filtered["rows"]], ["600004"])
        self.assertEqual(filtered["stats"]["total"], 1)
        self.assertEqual(filtered["board_counts"], [{"boards": 1, "count": 1}])
        self.assertEqual(len(db.date_view(self.conn, "2025-10-14")["rows"]), 4)

    def test_missing_day_remains_distinct_from_confirmed_empty_day(self):
        self.save("2025-10-14", [])
        known = db.date_view(self.conn, "2025-10-14")
        missing = db.date_view(self.conn, "2025-10-15")
        self.assertEqual(known["data_status"], "ok")
        self.assertEqual(missing["data_status"], "missing")
        self.assertIn("不能据此判断", missing["coverage_note"])

    def test_contiguous_source_boards_make_a_cycle(self):
        for day, boards in (("2025-10-14", 1), ("2025-10-15", 2), ("2025-10-16", 3)):
            self.save(day, [event(boards=boards)])
        result = db.stock_view(self.conn, "000001", "2025-10-14", "2025-10-31")
        self.assertEqual(len(result["cycles"]), 1)
        cycle = result["cycles"][0]
        self.assertEqual((cycle["start"], cycle["end"], cycle["boards"]), ("2025-10-14", "2025-10-16", 3))
        self.assertTrue(cycle["start_known"])
        self.assertTrue(cycle["ongoing"])
        self.assertFalse(cycle["end_known"])

    def test_explicit_data_gap_is_not_joined_into_a_confirmed_cycle(self):
        self.save("2025-10-14", [event(boards=1)])
        self.save("2025-10-15", [], status="failed", note="模拟缺失")
        self.save("2025-10-16", [event(boards=2)])
        result = db.stock_view(self.conn, "000001", "2025-10-14", "2025-10-31")
        self.assertEqual(len(result["cycles"]), 2)
        self.assertFalse(result["cycles"][0]["start_known"])
        self.assertTrue(result["cycles"][0]["clipped"])
        self.assertFalse(result["cycles"][1]["end_known"])

    def test_cycle_skips_verified_full_suspensions_even_when_source_restarts_boards(self):
        days = ["2025-05-26", "2025-05-27", "2025-05-28", "2025-05-29", "2025-05-30",
                "2025-06-03", "2025-06-04", "2025-06-05", "2025-06-06", "2025-06-09", "2025-06-10"]
        db.set_settings(self.conn, calendar_dates=days)
        observations = {days[0]: 1, days[1]: 2, days[7]: 1, days[8]: 2, days[9]: 3}
        for day in days:
            self.save(day, [event(boards=observations[day])] if day in observations else [])
        halted = days[2:7]
        for day in halted:
            db.save_suspensions(self.conn, day, [{"code": "000001", "name": "测试甲",
                "start": "2025-05-28T09:30:00", "end": "2025-06-04T15:00:00",
                "resume": "2025-06-05", "reason": "synthetic", "full_day": True}], "synthetic", [])
        before = [tuple(r) for r in self.conn.execute("SELECT * FROM events ORDER BY date,code")]
        result = db.stock_view(self.conn, "000001", days[0], days[-1])
        self.assertEqual(result["stats"], {"limit_days": 5, "max_boards": 5, "cycles": 1})
        cycle = result["cycles"][0]
        self.assertEqual((cycle["start"], cycle["end"], cycle["boards"]), (days[0], days[9], 5))
        self.assertEqual(cycle["dates"], list(observations))
        self.assertEqual(cycle["suspension_dates"], halted)
        self.assertTrue(cycle["start_known"])
        self.assertTrue(cycle["end_known"])
        self.assertFalse(cycle["ongoing"])
        self.assertIn("停牌", cycle["note"])
        self.assertEqual(before, [tuple(r) for r in self.conn.execute("SELECT * FROM events ORDER BY date,code")])
        cutoff = db.stock_view(self.conn, "000001", days[0], days[6])
        self.assertEqual(cutoff["cycles"][0]["boards"], 2)
        self.assertTrue(cutoff["cycles"][0]["ongoing"])
        self.assertFalse(cutoff["cycles"][0]["end_known"])
        self.assertEqual(cutoff["as_of_date"], days[6])

    def test_partial_or_uncovered_trading_days_cannot_bridge_cycles(self):
        days = ["2025-10-14", "2025-10-15", "2025-10-16", "2025-10-17"]
        db.set_settings(self.conn, calendar_dates=days)
        for day in days:
            self.save(day, [event()] if day in (days[0], days[-1]) else [])
        record = {"code": "000001", "name": "测试甲", "start": days[1] + "T09:30:00",
                  "end": days[2] + "T15:00:00", "resume": days[-1], "reason": "synthetic", "full_day": True}
        db.save_suspensions(self.conn, days[1], [record], "synthetic", [])
        result = db.stock_view(self.conn, "000001", days[0], days[-1])
        self.assertEqual(len(result["cycles"]), 2, "the uncovered non-limit trading day still breaks the cycle")
        db.save_suspensions(self.conn, days[2], [{**record, "full_day": False}], "synthetic", [])
        self.assertEqual(len(db.stock_view(self.conn, "000001", days[0], days[-1])["cycles"]), 2)
        db.save_suspensions(self.conn, days[2], [record], "synthetic", [])
        self.assertEqual(len(db.stock_view(self.conn, "000001", days[0], days[-1])["cycles"]), 1)

    def test_monotone_source_boards_continue_across_a_full_suspension(self):
        days = ["2025-10-14", "2025-10-15", "2025-10-16"]
        db.set_settings(self.conn, calendar_dates=days)
        for day, rows in zip(days, [[event()], [], [event(boards=2)]]):
            self.save(day, rows)
        db.save_suspensions(self.conn, days[1], [{"code": "000001", "name": "测试甲",
            "start": days[1] + "T09:30:00", "end": days[1] + "T15:00:00",
            "resume": days[2], "reason": "synthetic", "full_day": True}], "synthetic", [])
        result = db.stock_view(self.conn, "000001", days[0], days[-1])
        self.assertEqual(result["stats"], {"limit_days": 2, "max_boards": 2, "cycles": 1})

    def test_confirmed_nonlimit_day_separates_distinct_cycles(self):
        self.save("2025-10-14", [event(boards=1)])
        self.save("2025-10-15", [])
        self.save("2025-10-16", [event(boards=1)])
        result = db.stock_view(self.conn, "000001", "2025-10-14", "2025-10-31")
        self.assertEqual(len(result["cycles"]), 2)
        self.assertFalse(result["cycles"][1]["ongoing"])
        self.assertTrue(result["cycles"][1]["end_known"])

    def test_query_interval_marks_full_cycle_as_clipped(self):
        for day, boards in (("2025-10-14", 1), ("2025-10-15", 2), ("2025-10-16", 3)):
            self.save(day, [event(boards=boards)])
        result = db.stock_view(self.conn, "000001", "2025-10-15", "2025-10-15")
        self.assertEqual(result["stats"]["limit_days"], 1)
        self.assertEqual(result["stats"]["max_boards"], 2)
        self.assertEqual(len(result["rows"]), 1)
        self.assertTrue(result["cycles"][0]["clipped"])
        self.assertEqual(result["cycles"][0]["start"], "2025-10-14")
        self.assertEqual(result["cycles"][0]["boards"], 2)
        self.assertEqual(result["cycles"][0]["end"], "2025-10-15")
        self.assertEqual(result["as_of_date"], "2025-10-15")
        self.assertTrue(result["cycles"][0]["ongoing"])

    def test_failed_following_day_cannot_confirm_a_cycle_ended(self):
        self.save("2025-10-14", [event(boards=1)])
        self.save("2025-10-15", [], status="failed", note="模拟缺失")
        self.save("2025-10-16", [])
        result = db.stock_view(self.conn, "000001", "2025-10-14", "2025-10-31")
        self.assertFalse(result["cycles"][0]["ongoing"])
        self.assertFalse(result["cycles"][0]["end_known"])

    def test_database_constraint_failure_rolls_back_snapshot_replacement(self):
        self.save("2025-10-14", [event(boards=3)])
        malformed = event("600001", boards=1)
        malformed.pop("name")
        with self.assertRaises((ValueError, KeyError, sqlite3.IntegrityError)):
            self.save("2025-10-14", [malformed])
        rows = db.date_view(self.conn, "2025-10-14")["rows"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["code"], rows[0]["boards"]), ("000001", 3))

    def test_known_unattempted_trading_day_prevents_confirmed_continuity(self):
        db.set_settings(self.conn, calendar_dates=["2025-10-14", "2025-10-15", "2025-10-16"])
        self.save("2025-10-14", [event(boards=1)])
        self.save("2025-10-16", [event(boards=2)])
        result = db.stock_view(self.conn, "000001", "2025-10-14", "2025-10-31")
        self.assertEqual(len(result["cycles"]), 2)
        self.assertFalse(result["cycles"][1]["end_known"])

    def test_known_unattempted_trading_day_prevents_confirmed_end(self):
        db.set_settings(self.conn, calendar_dates=["2025-10-14", "2025-10-15", "2025-10-16"])
        self.save("2025-10-14", [event(boards=1)])
        self.save("2025-10-16", [])
        result = db.stock_view(self.conn, "000001", "2025-10-14", "2025-10-31")
        self.assertFalse(result["cycles"][0]["end_known"])

    def request(self, path):
        handler = object.__new__(app.Handler)
        handler.path = path
        handler.headers = {}
        handler.server = SimpleNamespace(db_path=":memory:")
        handler.wfile = io.BytesIO()
        response = {"headers": {}}
        handler.send_response = lambda status: response.update(status=status)
        handler.send_header = lambda key, value: response["headers"].update({key: value})
        handler.end_headers = lambda: None
        request_conn = db.connect(":memory:")
        self.conn.backup(request_conn)
        with patch.object(app.db, "connect", return_value=request_conn):
            handler.do_GET()
        response["body"] = handler.wfile.getvalue()
        return response

    def test_api_rejects_bad_dates_codes_and_filters(self):
        for path in (
            "/api/date?date=2025-02-30",
            "/api/date?date=20251014",
            "/api/date?min_boards=0",
            "/api/date?min_boards=not-a-number",
            "/api/date?exclude_st=yes",
            "/api/date?exclude_st=-1",
            "/api/date?exclude_gem=yes",
            "/api/date?exclude_gem=-1",
            "/api/date?exclude_gem=2",
            "/api/stock?code=123",
        ):
            with self.subTest(path=path):
                result = self.request(path)
                self.assertEqual(result["status"], 400)
                self.assertIn("error", json.loads(result["body"]))

    def test_stock_api_uses_available_bounds_and_ignores_legacy_ranges(self):
        self.save("2025-10-14", [event(boards=1)])
        self.save("2025-10-15", [event(boards=2)])
        self.save("2025-10-16", [event("600001", "其他股票", 1)])
        self.save("2025-10-17", [], status="failed")
        for suffix in ("", "&start=2025-10-15&end=2025-10-15", "&start=bad&end=bad",
                       "&date=2025-10-14&start=2025-10-16&end=2025-10-14"):
            with self.subTest(suffix=suffix):
                response = self.request("/api/stock?code=000001" + suffix)
                self.assertEqual(response["status"], 200)
                result = json.loads(response["body"])
                self.assertEqual((result["range_start"], result["range_end"]), ("2025-10-14", "2025-10-16"))
                self.assertEqual(result["range_mode"], "archive")
                self.assertEqual(result["stats"]["limit_days"], 2)
        self.save("2025-10-17", [event(boards=1)])
        refreshed = json.loads(self.request("/api/stock?code=000001")["body"])
        self.assertEqual(refreshed["range_end"], "2025-10-17")
        self.assertEqual(refreshed["stats"]["limit_days"], 3)

    def test_full_history_relations_include_both_sides_of_obsolete_range(self):
        self.save("2025-10-13", [event(), event("000009", "前序样本")])
        self.save("2025-10-14", [event(boards=1), event("000002", "对手乙", 1)])
        self.save("2025-10-15", [event(boards=2), event("000003", "对手丙", 2)])
        self.save("2025-10-16", [event("000003", "对手丙", 3)])
        result = json.loads(self.request("/api/stock?code=000001&start=2025-10-15&end=2025-10-15")["body"])
        relations = result["relationships"]
        self.assertEqual((relations["range_start"], relations["range_end"]), ("2025-10-14", "2025-10-16"))
        self.assertEqual(relations["competition"]["win_round_count"], 1)
        self.assertEqual(relations["competition"]["loss_round_count"], 1)
        self.assertEqual({row["code"] for row in relations["cooccurrences"]["rows"]}, {"000002", "000003"})
        self.assertEqual(result["stats"]["limit_days"], 2)

    def test_empty_archive_uses_configured_bounds_without_range_controls(self):
        response = self.request("/api/stock?code=000001&start=bad&end=bad")
        self.assertEqual(response["status"], 200)
        result = json.loads(response["body"])
        self.assertEqual((result["range_start"], result["range_end"]), ("2025-10-14", "2025-10-31"))
        self.assertEqual(result["rows"], [])
        self.assertEqual(result["relationships"]["target_limit_days"], 0)

    def test_removed_export_endpoint_returns_not_found(self):
        self.assertEqual(self.request("/api/export?date=2025-10-14")["status"], 404)

    def test_api_applies_st_exclusion_to_historical_names(self):
        self.save("2025-10-14", [event("000001", "ST历史名称", boards=2),
                                 event("600001", "普通股", boards=3),
                                 event("000002", "*ST历史名称", boards=4)])
        self.save("2025-10-15", [event("000001", "摘帽名称", boards=3)])
        result = self.request("/api/date?date=2025-10-14&exclude_st=1&min_boards=2")
        self.assertEqual(result["status"], 200)
        self.assertEqual([row["code"] for row in json.loads(result["body"])["rows"]], ["600001"])

    def test_exact_board_api_and_invalid_selections(self):
        self.save("2025-10-14", [event("000001", boards=2), event("000002", boards=3), event("000003", boards=4)])
        result = self.request("/api/date?date=2025-10-14&boards=3")
        self.assertEqual(result["status"], 200)
        payload = json.loads(result["body"])
        self.assertEqual([row["code"] for row in payload["rows"]], ["000002"])
        self.assertEqual(payload["available_total"], 3)
        for boards in ("0", "-1", "3.5", "abc", "101"):
            with self.subTest(boards=boards):
                self.assertEqual(self.request("/api/date?date=2025-10-14&boards=" + boards)["status"], 400)
        for suffix in ("", "&boards="):
            self.assertEqual(len(json.loads(self.request("/api/date?date=2025-10-14" + suffix)["body"])["rows"]), 3)
        compatible = self.request("/api/date?date=2025-10-14&min_boards=3")
        self.assertEqual([row["boards"] for row in json.loads(compatible["body"])["rows"]], [4, 3])

    def test_api_gem_checkbox_filters_rows_and_counts_and_can_be_cleared(self):
        self.save("2025-10-14", [event("300001", "创业甲", boards=3),
                                 event("301001", "创业乙", boards=1),
                                 event("600001", "普通沪市", boards=1),
                                 event("688001", "科创测试", boards=2)])
        response = self.request("/api/date?date=2025-10-14&exclude_gem=1&boards=2")
        self.assertEqual(response["status"], 200)
        filtered = json.loads(response["body"])
        self.assertEqual([row["code"] for row in filtered["rows"]], ["688001"])
        self.assertEqual(filtered["available_total"], 2)
        self.assertEqual(filtered["board_counts"], [{"boards": 1, "count": 1}, {"boards": 2, "count": 1}])
        for suffix in ("", "&exclude_gem=0"):
            self.assertEqual(len(json.loads(self.request("/api/date?date=2025-10-14" + suffix)["body"])["rows"]), 4)



class ProviderTests(unittest.TestCase):
    """Verify source parsing without network requests or filesystem writes."""

    def raw(self, **changes):
        tz = timezone(timedelta(hours=8))
        stamp = lambda hour, minute: int(datetime(2025, 10, 14, hour, minute, tzinfo=tz).timestamp())
        row = {"symbol": "000001.SZ", "stock_chi_name": "测试股份", "limit_up_days": 2,
               "first_limit_up": stamp(9, 30), "last_limit_up": stamp(14, 45),
               "price": 12.3, "change_percent": 0.10018, "turnover_ratio": 0.235,
               "break_limit_up_times": 0, "surge_reason": {"stock_reason": "测试原因"}}
        return {**row, **changes}

    def normalize(self, *rows):
        return provider.normalize_pool({"code": 20000, "data": list(rows)}, "2025-10-14")

    def test_fractional_source_ratios_are_converted_to_percent(self):
        rows, _ = self.normalize(self.raw())
        self.assertEqual(rows[0]["code"], "000001")
        self.assertEqual(rows[0]["boards"], 2)
        self.assertAlmostEqual(rows[0]["pct_change"], 10.018)
        self.assertAlmostEqual(rows[0]["turnover"], 23.5)
        self.assertEqual(rows[0]["close"], 12.3)
        self.assertEqual(rows[0]["open_times"], 0)
        self.assertEqual(rows[0]["first_time"], "09:30:00")
        self.assertEqual(rows[0]["last_time"], "14:45:00")
        self.assertEqual(rows[0]["limit_up_reason"], "测试原因")

    def test_wrong_source_date_rejects_whole_pool(self):
        for field in ("first_limit_up", "last_limit_up"):
            row = self.raw()
            row[field] -= 86400
            with self.subTest(field=field), self.assertRaises(provider.ProviderError):
                self.normalize(self.raw(), row)

    def test_reversed_optional_seal_times_are_missing_but_date_is_still_validated(self):
        row = self.raw()
        row["first_limit_up"], row["last_limit_up"] = row["last_limit_up"], row["first_limit_up"]
        rows, note = self.normalize(row)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["first_time"])
        self.assertIsNone(rows[0]["last_time"])
        self.assertEqual(rows[0]["date"], "2025-10-14")
        self.assertEqual(rows[0]["boards"], 2)
        self.assertIn("000001", note)
        self.assertIn("按缺失保存", note)
        row["last_limit_up"] -= 86400
        with self.assertRaises(provider.ProviderError):
            self.normalize(row)

    def test_identical_duplicates_deduplicated_and_conflicts_rejected(self):
        row = self.raw()
        normalized, note = self.normalize(row, deepcopy(row))
        self.assertEqual(len(normalized), 1)
        self.assertIn("重复", note)
        with self.assertRaises(provider.ProviderError):
            self.normalize(row, self.raw(limit_up_days=3))

    def test_approved_zero_rows_do_not_block_other_verified_stocks(self):
        for day, code in sorted(provider.IGNORED_HISTORY_ZERO_FIELDS):
            with self.subTest(day=day, code=code):
                stamp = int(datetime.fromisoformat(day).replace(hour=10, tzinfo=provider.TZ).timestamp())
                valid = self.raw(first_limit_up=stamp, last_limit_up=stamp)
                invalid = self.raw(symbol=f"{code}.SZ", limit_up_days=0, first_limit_up=0, last_limit_up=0)
                payload = {"code": 20000, "data": [invalid, valid]}
                response = SimpleNamespace(json=lambda: payload)
                with patch.object(provider, "_get", return_value=response), patch.object(provider, "_save_raw", return_value="synthetic.json"):
                    result = provider.fetch_day(day)
                self.assertEqual(result.status, "ok")
                self.assertEqual([(row["code"], row["date"]) for row in result.records], [("000001", day)])
                self.assertIn(code, result.note)
                with db.connect(":memory:") as conn:
                    db.save_day(conn, day, result.records, result.source, note=result.note)
                    saved = conn.execute("SELECT count,note FROM days WHERE date=?", (day,)).fetchone()
                    self.assertEqual(saved["count"], 1)
                    self.assertIn("已按确认跳过", saved["note"])
                    self.assertIsNone(conn.execute("SELECT 1 FROM events WHERE code=?", (code,)).fetchone())

    def test_exclusion_is_limited_to_approved_pair_and_known_defect(self):
        day = "2020-02-25"
        invalid = self.raw(symbol="000953.SZ", limit_up_days=0, first_limit_up=0, last_limit_up=0)
        for when, row in (("2020-02-26", invalid),
                          (day, {**invalid, "symbol": "000954.SZ"}),
                          (day, {**invalid, "limit_up_days": 1}),
                          (day, {**invalid, "limit_up_days": False}),
                          (day, {**invalid, "first_limit_up": None})):
            with self.subTest(day=when, row=row), self.assertRaises(provider.ProviderError):
                provider.normalize_pool({"code": 20000, "data": [row]}, when)
        # The exclusion cannot hide another stock's bad date or a pool date mismatch.
        with self.assertRaises(provider.ProviderError):
            provider.normalize_pool({"code": 20000, "data": [invalid, self.raw()]}, day)
        with self.assertRaises(provider.ProviderError):
            provider.normalize_pool({"code": 20000, "date": "2020-02-26", "data": [invalid]}, day)

    def test_corrected_excluded_stock_is_accepted_and_all_ignored_pool_stays_empty(self):
        day, code = "2020-02-25", "000953"
        stamp = int(datetime(2020, 2, 25, 10, tzinfo=provider.TZ).timestamp())
        corrected = self.raw(symbol=f"{code}.SZ", first_limit_up=stamp, last_limit_up=stamp)
        rows, note = provider.normalize_pool({"code": 20000, "data": [corrected]}, day)
        self.assertEqual(rows[0]["code"], code)
        self.assertNotIn("跳过", note)
        invalid = {**corrected, "limit_up_days": "0", "first_limit_up": "0", "last_limit_up": "0"}
        response = SimpleNamespace(json=lambda: {"code": 20000, "data": [invalid]})
        with patch.object(provider, "_get", return_value=response), patch.object(provider, "_save_raw", return_value="synthetic.json"):
            result = provider.fetch_day(day)
        self.assertEqual((result.status, result.records), ("empty", []))
        self.assertIn("跳过", result.note)

    def test_approved_missing_first_time_row_is_skipped_until_corrected(self):
        day = "2020-05-19"
        stamp = int(datetime(2020, 5, 19, 10, tzinfo=provider.TZ).timestamp())
        row = self.raw(symbol="000615.SZ", limit_up_days=1, first_limit_up=0, last_limit_up=stamp)
        rows, note = provider.normalize_pool({"code": 20000, "data": [row]}, day)
        self.assertEqual(rows, [])
        self.assertIn("000615（首次封板时间为 0）", note)
        rows, note = provider.normalize_pool({"code": 20000, "data": [{**row, "first_limit_up": stamp}]}, day)
        self.assertEqual(rows[0]["code"], "000615")
        self.assertNotIn("跳过", note)
        with self.assertRaises(provider.ProviderError):
            provider.normalize_pool({"code": 20000, "data": [row]}, "2020-05-20")

    def test_malformed_source_values_cannot_become_valid_records(self):
        for changes in (
            {"limit_up_days": 2.5}, {"limit_up_days": True}, {"limit_up_days": 0},
            {"price": 0}, {"price": "NaN"}, {"change_percent": "Infinity"},
            {"turnover_ratio": "NaN"}, {"break_limit_up_times": -1},
            {"break_limit_up_times": 0.5}, {"stock_chi_name": ""},
            {"symbol": "000001"}, {"surge_reason": "unexpected"},
        ):
            with self.subTest(changes=changes), self.assertRaises(provider.ProviderError):
                self.normalize(self.raw(**changes))

    def test_values_overflowing_float_or_percent_conversion_are_rejected(self):
        for changes in ({"price": "1e1000"}, {"limit_up_days": "1e1000"},
                        {"change_percent": "1e308"}, {"turnover_ratio": "1e308"}):
            with self.subTest(changes=changes), self.assertRaises(provider.ProviderError):
                self.normalize(self.raw(**changes))

    def test_unknown_payload_shapes_are_rejected(self):
        for payload in (None, [], {"code": 20000, "data": {}}, {"code": 0, "data": []}):
            with self.subTest(payload=payload), self.assertRaises(provider.ProviderError):
                provider.normalize_pool(payload, "2025-10-14")

    def test_unstamped_empty_pool_is_an_unknown_day(self):
        response = SimpleNamespace(json=lambda: {"code": 20000, "data": []})
        with patch.object(provider, "_get", return_value=response), patch.object(provider, "_save_raw", return_value="synthetic.json"):
            result = provider.fetch_day("2025-10-14")
        self.assertEqual(result.status, "empty")
        self.assertEqual(result.records, [])
        self.assertIn("无法据此认定", result.note)

    def test_calendar_duplicate_and_out_of_range_dates_rejected(self):
        for dates in (("2025-10-14", "2025-10-14"), ("2025-10-13", "2025-10-14")):
            payload = {"code": 0, "data": {"sh000001": {"day": [[day, "unused"] for day in dates]}}}
            response = SimpleNamespace(json=lambda: payload)
            with self.subTest(dates=dates), patch.object(provider, "_get", return_value=response), patch.object(provider, "_save_raw", return_value="synthetic.json"):
                with self.assertRaises(provider.ProviderError):
                    provider.trading_dates("2025-10-14", "2025-10-16")


if __name__ == "__main__":
    unittest.main()
