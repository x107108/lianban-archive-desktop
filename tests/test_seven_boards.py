from contextlib import closing
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

import app
import database as db
import intraday
from seven_boards import BROKEN_POOL_SOURCE, archive_runs, checked_prices


class SevenBoardTests(unittest.TestCase):
    def test_confirmed_close_and_next_trading_day_break_use_separate_evidence(self):
        path = Path(__file__).parent / "test-data" / ("seven-" + uuid4().hex) / "archive.sqlite3"
        dates = ["2026-10-" + str(day) for day in (19, 20, 21, 22, 23, 26, 27, 28, 29)]

        def event(code, boards):
            return {"code": code, "name": code, "boards": boards, "close": 11, "pct_change": 10}

        with closing(db.connect(path)) as archive:
            db.set_settings(archive, calendar_dates=dates)
            for boards, day in enumerate(dates[:6], 1):
                db.save_day(archive, day, [event(code, boards) for code in ("600001", "600002", "600003", "600004")], "synthetic")
            db.save_day(archive, dates[6], [event("600001", 7)], "synthetic")
            # The eighth day is in the calendar, but missing from the archive.
            db.save_day(archive, dates[8], [event("600004", 7)], "synthetic")
        server = SimpleNamespace(db_path=path)
        data = app.read_api(server, "/api/seven-boards")
        self.assertEqual(data["total"], 2)
        self.assertEqual(data["unchecked_dates"], 1)
        self.assertEqual(data["rows"][0]["days"][:6], [None] * 6)
        self.assertFalse(intraday.store_path(path).exists())

        def broken(code):
            return {"date": dates[6], **event(code, 0), "market": "沪市主板"}

        with closing(intraday.connect(intraday.store_path(path))) as cache, cache:
            cache.execute("INSERT INTO broken_pools VALUES (?,?,?,?,?)",
                          (dates[6], json.dumps([broken("600001"), broken("600002")]), BROKEN_POOL_SOURCE,
                           dates[6] + "T14:00:00+08:00", "synthetic.json"))
        self.assertEqual(app.read_api(server, "/api/seven-boards")["total"], 2)

        with closing(intraday.connect(intraday.store_path(path))) as cache, cache:
            cache.execute("UPDATE broken_pools SET fetched_at=?", (dates[6] + "T15:30:00+08:00",))
            day = {**event("600002", 0), "date": dates[6]}
            prices = [[slot, 11] for slot in range(5, 241, 5)]
            cache.execute("INSERT INTO seven_minutes VALUES (?,?,?,?,?)", checked_prices(day, prices, 5))
            with self.assertRaisesRegex(ValueError, "收盘价"):
                checked_prices(day, prices[:-1] + [[240, 10]], 5)

        with patch("requests.get", side_effect=AssertionError("archive reads are offline")):
            data = app.read_api(server, "/api/seven-boards?page=2")
        self.assertEqual((data["total"], data["unchecked_dates"]), (3, 0))
        self.assertEqual([(r["code"], r["outcome"]) for r in data["rows"]],
                         [("600004", "sealed"), ("600001", "sealed"), ("600002", "broken")])
        days = data["rows"][2]["days"]
        self.assertEqual([d["date"] for d in days], dates[:7])
        self.assertEqual((days[-1]["interval"], days[-1]["points"]), (5, prices))
        self.assertEqual(data["board_types"][6]["broken"], 1)
        self.assertEqual(data["board_types"][6]["opened"], 1)
        self.assertEqual(data["yearly_sealed"], {"2026": 2})

    def test_one_response_includes_the_whole_archive(self):
        path = Path(__file__).parent / "test-data" / ("seven-" + uuid4().hex) / "archive.sqlite3"
        with closing(db.connect(path)) as archive:
            for day, codes in (("2026-10-20", range(600001, 600013)), ("2026-10-21", [600013])):
                db.save_day(archive, day, [{"code": str(code), "name": str(code), "boards": 7}
                                          for code in codes], "synthetic")
        data = app.read_api(SimpleNamespace(db_path=path), "/api/seven-boards")
        self.assertEqual(data["total"], 13)
        self.assertEqual([row["date"] for row in data["rows"]], ["2026-10-21"] + ["2026-10-20"] * 12)

    def test_yearly_seal_counts_deduplicate_within_year_and_follow_filters(self):
        path = Path(__file__).parent / "test-data" / ("seven-" + uuid4().hex) / "archive.sqlite3"
        normal = {"code": "600001", "name": "示例", "boards": 7}
        st = {"code": "600002", "name": "ST示例", "boards": 7, "open_times": 1}
        with closing(db.connect(path)) as archive:
            for day, stocks in (("2025-10-21", [normal]), ("2026-02-20", [normal, st]), ("2026-10-21", [normal])):
                db.save_day(archive, day, stocks, "synthetic")
        server = SimpleNamespace(db_path=path)
        self.assertEqual(app.read_api(server, "/api/seven-boards")["yearly_sealed"], {"2025": 1, "2026": 1})
        self.assertEqual(app.read_api(server, "/api/seven-boards?exclude_st=0")["yearly_sealed"], {"2025": 1, "2026": 2})

    def test_default_filters_and_board_types_share_the_same_cohort(self):
        path = Path(__file__).parent / "test-data" / ("seven-" + uuid4().hex) / "archive.sqlite3"
        stocks = [("600001", "普通一", "09:25:03", 0), ("600002", "普通二", "09:30:00", 1),
                  ("600003", "普通三", "10:00:00", 2), ("600004", "普通四", None, None),
                  ("600005", "*ST示例", "09:25:00", 0), ("301001", "创业板示例", "09:25:00", 1)]
        with closing(db.connect(path)) as archive:
            db.save_day(archive, "2026-10-21",
                        [{"code": code, "name": name, "boards": 7, "first_time": first_time, "open_times": opens}
                         for code, name, first_time, opens in stocks], "synthetic")
        server = SimpleNamespace(db_path=path)
        data = app.read_api(server, "/api/seven-boards")
        self.assertEqual(data["total"], 4)
        self.assertEqual(data["board_types"][0]["unknown"], 4)
        self.assertEqual(data["board_types"][6], {"one_price": 1, "t_shape": 1, "intraday": 1, "broken": 0, "unknown": 1, "opened": 2})
        self.assertEqual(app.read_api(server, "/api/seven-boards?exclude_st=0")["board_types"][6]["one_price"], 2)
        self.assertEqual(app.read_api(server, "/api/seven-boards?exclude_gem=0")["board_types"][6]["t_shape"], 2)
        all_rows = app.read_api(server, "/api/seven-boards?exclude_st=0&exclude_gem=0")
        self.assertEqual(len(all_rows["rows"]), 6)
        self.assertTrue(all(sum(counts.values()) - counts["opened"] == 6 for counts in all_rows["board_types"]))

    def test_sealed_cycle_continues_past_verified_suspension_and_ends_on_attempt(self):
        path = Path(__file__).parent / "test-data" / ("seven-" + uuid4().hex) / "archive.sqlite3"
        days = ["2026-10-" + str(day) for day in (19, 20, 21, 22, 23, 26, 27)]
        code = "600001"
        with closing(db.connect(path)) as archive:
            for day, boards in zip(days, (7, None, 8, None, 9, None, 1)):
                db.save_day(archive, day, [{"code": code, "name": "示例", "boards": boards}] if boards else [], "synthetic")
            db.save_suspensions(archive, days[1], [{"code": code, "name": "示例", "start": days[1], "end": None,
                                                  "resume": days[2], "reason": "", "full_day": True}], "synthetic", [])
            db.save_stock_note(archive, code, "测试备注", 0)
        with closing(intraday.connect(intraday.store_path(path))) as cache, cache:
            cache.execute("INSERT INTO seven_halts VALUES (?,?)", (days[3], code))
            terminal = {"date": days[5], "code": code}
            prices = [[slot, 10] for slot in range(1, 241)]
            cache.execute("INSERT INTO seven_minutes VALUES (?,?,?,?,?)", checked_prices(terminal, prices, 1, reference=10))
            with closing(db.connect(path)) as archive:
                runs, unchecked = archive_runs(archive, cache, since=days[4])
            self.assertEqual((len(runs), unchecked), (1, {days[5]}))
        server = SimpleNamespace(db_path=path)
        run = app.read_api(server, "/api/seven-boards")["rows"][0]
        self.assertEqual([day["date"] for day in run["days"][6:]], [days[i] for i in (0, 2, 4, 5)])
        self.assertEqual([day["boards"] for day in run["days"][6:9]], [7, 8, 9])
        self.assertEqual(run["days"][-1]["terminal"], "unsealed")
        self.assertEqual(run["days"][-1]["pct_change"], 0)
        self.assertEqual(run["note"], "测试备注")
        self.assertIn("tags", run)
        server.read_only = True
        self.assertNotIn("note", app.read_api(server, "/api/seven-boards")["rows"][0])
