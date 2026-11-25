"""Suspension continuity requires dated source evidence; raw pool facts stay intact."""
from contextlib import closing, nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4
import unittest

import app
import database as db
import seven_boards
import suspension
import suspension_history as history


class Result:
    error_code, error_msg = "0", "success"
    fields = history.FIELDS

    def __init__(self, rows):
        self.rows = iter(rows)

    def next(self):
        self.row = next(self.rows, None)
        return self.row is not None

    def get_row_data(self):
        return self.row


class SuspensionHistoryTests(unittest.TestCase):
    dates = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24",
             "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"]

    def setUp(self):
        self.path = Path(__file__).parent / "test-data" / ("history-" + uuid4().hex) / "archive.sqlite3"
        with closing(db.connect(self.path)) as conn:
            db.set_settings(conn, calendar_dates=self.dates, range_start=self.dates[0], range_end=self.dates[-1])
            for i, day in enumerate(self.dates):
                rows = [] if i in (2, 3, 9) else [{"code": "600001", "name": "合成测试", "boards": i + 1 if i < 2 else i - 3,
                                                   "close": 12 if i == 1 else 13.2, "pct_change": 10}]
                db.save_day(conn, day, rows, "synthetic")
            self.before = [tuple(row) for row in conn.execute("SELECT * FROM events ORDER BY date,code")]
            self.job = history.cycle_gaps(conn)[0]

    def client(self, *, second_status="0", blank_volume=False):
        rows = [[day, "sh.600001", "12" if i < 4 else "13.2", "12",
                 "" if blank_volume and i in (2, 3) else "0" if i in (2, 3) else "100", "0" if i in (2, 3) else "1"]
                for i, day in enumerate(self.dates)]
        rows[3][-1] = second_status
        client = Mock()
        client.query_history_k_data_plus.side_effect = lambda symbol, fields, *, start_date, end_date, **kw: Result(
            [row for row in rows if start_date <= row[0] <= end_date])
        return client

    def collect(self, client):
        with patch.object(history, "baostock_session", return_value=nullcontext(client)):
            return history.collect(self.path, code="600001")

    def test_confirmed_full_halts_merge_source_reset_and_cache_without_editing_events(self):
        client = self.client(blank_volume=True)  # Missing volume is allowed only with explicit halted status.
        result = self.collect(client)
        self.assertEqual((result["checked"], result["suspended"]), (1, 1))
        with closing(db.connect(self.path)) as conn:
            shown = db.stock_view(conn, "600001", self.dates[0], self.dates[-1])
            self.assertEqual(len(shown["cycles"]), 1)
            self.assertEqual((shown["cycles"][0]["boards"], shown["cycles"][0]["suspension_dates"]), (7, self.dates[2:4]))
            self.assertEqual(self.before, [tuple(row) for row in conn.execute("SELECT * FROM events ORDER BY date,code")])
            db.save_suspensions(conn, self.dates[2], [], "synthetic-empty", [])
            self.assertEqual(db.stock_view(conn, "600001", self.dates[0], self.dates[-1])["cycles"][0]["boards"], 7)
        self.assertEqual(self.collect(client)["checked"], 0)
        self.assertEqual(client.query_history_k_data_plus.call_count, 2)

    def test_one_traded_day_proves_break_without_querying_whole_interval(self):
        client = Mock()
        client.query_history_k_data_plus.return_value = Result([[self.dates[2], "sh.600001", "12", "12", "100", "1"]])
        self.assertEqual(self.collect(client)["traded"], 1)
        self.assertEqual(client.query_history_k_data_plus.call_count, 1)
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(len(db.stock_view(conn, "600001", self.dates[0], self.dates[-1])["cycles"]), 2)
            self.assertEqual(history.cycle_gaps(conn, code="600001"), [])

    def test_partial_halt_does_not_bridge_a_normally_traded_day(self):
        self.assertEqual(self.collect(self.client(second_status="1"))["traded"], 1)
        with closing(db.connect(self.path)) as conn:
            self.assertEqual([r[0] for r in conn.execute("SELECT date FROM verified_suspension_days")], [self.dates[2]])
            self.assertEqual(len(db.stock_view(conn, "600001", self.dates[0], self.dates[-1])["cycles"]), 2)

    def test_missing_wrong_or_inconsistent_source_records_never_prove_suspension(self):
        valid = [self.dates[2], "sh.600001", "12", "12", "0", "0"]
        for values in ([], [[self.dates[2], "sz.600001", "12", "12", "0", "0"]],
                       [valid, valid], [[self.dates[2], "sh.600001", "12", "12", "100", "0"]],
                       [[self.dates[3], "sh.600001", "12", "12", "0", "0"]]):
            client = Mock()
            client.query_history_k_data_plus.return_value = Result(values)
            with self.subTest(values=values), self.assertRaises(ValueError):
                history.verify_gap(client, self.job, self.path.parent / "raw")
        client = self.client()
        job = {**self.job, "previous_close": 99}
        with self.assertRaisesRegex(ValueError, "边界行情"):
            history.verify_gap(client, job, self.path.parent / "raw")

    def test_unknown_is_retryable_and_never_erases_previously_verified_dates(self):
        with closing(db.connect(self.path)) as conn, conn:
            conn.execute("INSERT INTO verified_suspension_days VALUES (?,?,?,?)", (self.dates[2], "600001", "synthetic", db.now_iso()))
        client = Mock()
        client.query_history_k_data_plus.return_value = Result([])
        self.assertEqual(self.collect(client)["unknown"], 1)
        with closing(db.connect(self.path)) as conn, conn:
            self.assertEqual(history.cycle_gaps(conn), [])
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM verified_suspension_days").fetchone()[0], 1)
            conn.execute("UPDATE suspension_gap_checks SET checked_at='2026-01-01T00:00:00+08:00'")
            self.assertEqual(len(history.cycle_gaps(conn)), 1)

    def test_stock_pair_period_leader_and_seven_boards_share_suspension_rules(self):
        self.collect(self.client())
        with closing(db.connect(self.path)) as conn, conn:
            for i, day in enumerate(self.dates[:9]):
                if i not in (2, 3):
                    conn.execute("INSERT INTO events SELECT date,'600003','合成龙头',market,industry,boards,close,pct_change,turnover,first_time,last_time,open_times,limit_up_reason,source FROM events WHERE date=? AND code='600001'", (day,))
            conn.executemany("INSERT INTO verified_suspension_days VALUES (?,?,?,?)",
                             [(d, "600003", "synthetic", db.now_iso()) for d in self.dates[2:4]])
            for day in (self.dates[0], self.dates[8]):
                conn.execute("INSERT INTO events SELECT date,'600002','对比样本',market,industry,1,close,pct_change,turnover,first_time,last_time,open_times,limit_up_reason,source FROM events WHERE date=? AND code='600001'", (day,))
            result = db.stock_pair_comparison(conn, "600001", "600002", self.dates[0], self.dates[-1], db.get_settings(conn))
            self.assertEqual(len(result["segments"]), 1)
            self.assertEqual([r["boards"] for r in result["segments"][0]["target_dates"]], list(range(1, 8)))
            self.assertEqual(result["segments"][0]["leader"]["max_boards"], 7)
            runs, _ = seven_boards.archive_runs(conn, None)
            target = next(run for run in runs if run["code"] == "600001")
            self.assertEqual([r["date"] for r in target["days"][:7]], [d for i, d in enumerate(self.dates[:9]) if i not in (2, 3)])

    def test_background_requests_are_queued_once_and_stop_prevents_new_work(self):
        worker = suspension.Refresher(self.path)
        with patch.object(suspension.threading, "Thread") as thread, patch.object(history, "collect") as collect:
            self.assertTrue(worker.maybe_refresh_cycles("600001"))
            self.assertTrue(worker.maybe_refresh_cycles("600001"))
            self.assertEqual(thread.call_count, 1)
            self.assertTrue(worker.cycles_updating)
            worker._run_cycles()
            collect.assert_called_once()
            self.assertFalse(worker.cycles_updating)
        worker.stop()
        self.assertFalse(worker.maybe_refresh_cycles("600001"))

    def test_local_stock_query_triggers_verification_but_read_only_query_does_not(self):
        worker = SimpleNamespace(maybe_refresh_cycles=Mock(return_value=True))
        server = SimpleNamespace(db_path=self.path, suspension_refresher=worker)
        result = app.read_api(server, "/api/stock?code=600001")
        self.assertTrue(result["cycle_verification_pending"])
        worker.maybe_refresh_cycles.assert_called_once_with("600001")
        worker.maybe_refresh_cycles.reset_mock()
        server.read_only = True
        self.assertNotIn("cycle_verification_pending", app.read_api(server, "/api/stock?code=600001"))
        worker.maybe_refresh_cycles.assert_not_called()

    def test_new_archive_checks_do_not_depend_on_the_audit_price_screen(self):
        day = "2026-08-03"
        with closing(db.connect(self.path)) as conn:
            db.set_settings(conn, calendar_dates=[*self.dates, day])
            db.save_day(conn, day, [{"code": "600001", "name": "合成测试", "boards": 1, "close": 99, "pct_change": 10}], "synthetic")
            jobs = history.cycle_gaps(conn, latest_only=True)
            self.assertEqual([(r["code"], r["next_date"]) for r in jobs], [("600001", day)])
            self.assertEqual(history.cycle_gaps(conn, latest_only=True, plausible_only=True), [])


if __name__ == "__main__":
    unittest.main()
