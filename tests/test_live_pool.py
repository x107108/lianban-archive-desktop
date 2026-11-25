"""Provisional/closing isolation, minute scheduling, failures and cache progression."""
from contextlib import closing
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
import unittest

import app
import database as db
import intraday
import intraday_sources
import live_pool
import provider


class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        moment = cls.fromisoformat("2026-10-27T10:00:00+08:00")
        return moment.astimezone(tz) if tz else moment.replace(tzinfo=None)


class LivePoolTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).parent / "test-data" / ("live-pool-" + uuid4().hex)
        self.root.mkdir(parents=True)
        self.path = self.root / "archive.sqlite3"
        self.now = Clock.now(db.TZ)
        self.day = self.now.date().isoformat()
        self.previous = "2026-10-26"
        self.clock = patch.object(live_pool, "datetime", Clock)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.minute_clock = patch.object(intraday, "datetime", Clock)
        self.minute_clock.start()
        self.addCleanup(self.minute_clock.stop)
        self.row = {"date": self.day, "code": "600001", "name": "测试股份", "boards": 2,
                    "market": "沪市主板", "close": 11, "pct_change": 10,
                    "first_time": "09:40:00", "last_time": "09:40:00", "source": provider.CLS_SOURCE}
        with closing(db.connect(self.path)) as conn:
            db.set_settings(conn, range_start=self.previous, range_end=self.previous, calendar_dates=[self.previous])
            db.save_day(conn, self.previous, [{**self.row, "date": self.previous, "boards": 1}], provider.SOURCE)

    def result(self, rows=None):
        return provider.DayResult(self.day, [self.row] if rows is None else rows, "ok", "synthetic", "test.json", provider.CLS_SOURCE)

    def save(self, rows=None):
        with closing(db.connect(self.path)) as conn:
            return live_pool.save_snapshot(conn, self.result(rows), now=self.now)

    def test_snapshot_replaces_opened_stocks_without_entering_history_or_changing_edits(self):
        with closing(db.connect(self.path)) as conn:
            before = db.meta(conn)
            db.save_stock_tags(conn, "600001", ["自定义"], 0)
            db.save_stock_note(conn, "600001", "保留备注", 0)
            history = db.stock_view(conn, "600001", self.previous, self.previous)
        self.save()
        self.save([{**self.row, "code": "600002", "boards": 1}])
        with closing(db.connect(self.path)) as conn:
            after = db.meta(conn)
            pool = live_pool.snapshot(conn, self.day)
            self.assertEqual([r["code"] for r in pool["records"]], ["600002"])
            self.assertEqual((after["coverage"], after["latest_date"], after["archive_updated_at"]),
                             (before["coverage"], before["latest_date"], before["archive_updated_at"]))
            self.assertEqual(db.stock_view(conn, "600001", self.previous, self.previous)["relationships"], history["relationships"])
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM events WHERE date=?", (self.day,)).fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM days WHERE date=?", (self.day,)).fetchone()[0], 0)
            self.assertIn("自定义", db.get_stock_tags(conn, "600001")["tags"])
            self.assertEqual(db.get_stock_note(conn, "600001")["content"], "保留备注")

    def test_local_routes_show_provisional_date_but_public_and_history_stay_confirmed(self):
        self.save()
        local, public = SimpleNamespace(db_path=self.path), SimpleNamespace(db_path=self.path, read_only=True)
        with patch("requests.get", side_effect=AssertionError("GET must remain offline")):
            meta = app.read_api(local, "/api/meta")
            date = app.read_api(local, "/api/date?date=" + self.day)
            self.assertEqual(meta["latest_date"], self.previous)
            self.assertEqual(meta["live"]["date"], self.day)
            self.assertEqual(date["data_status"], "provisional")
            self.assertEqual(date["stats"]["total"], 1)
            self.assertEqual(date["rows"][0]["boards"], 2)
            self.assertNotIn("live", app.read_api(public, "/api/meta"))
            self.assertEqual(app.read_api(public, "/api/date?date=" + self.day)["data_status"], "missing")
            self.assertEqual(app.read_api(local, "/api/stock?code=600001")["stats"]["limit_days"], 1)
            overview = app.read_api(local, "/api/intraday?date=" + self.day)
            self.assertTrue(overview["provisional"])
            self.assertEqual(overview["rows"][0]["boards"], 2)
            stock = app.read_api(local, f"/api/intraday/stock?date={self.day}&code=600001")
            self.assertTrue(stock["needs_refresh"])
            timeline = app.read_api(local, "/api/intraday/timeline?date=" + self.day)
            self.assertTrue(timeline["provisional"])
            self.assertEqual(timeline["pool"][0]["code"], "600001")

    def test_invalid_replacement_is_atomic_and_wrong_dates_are_rejected(self):
        self.save()
        for rows in [[self.row, self.row], [{**self.row, "date": self.previous}], [{**self.row, "boards": 0}]]:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                self.save(rows)
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(live_pool.snapshot(conn, self.day)["records"][0]["boards"], 2)
            with self.assertRaises(ValueError):
                live_pool.save_snapshot(conn, provider.DayResult(self.previous, [self.row], "ok", "", ""), now=self.now)

    def test_close_supersedes_snapshot_and_counts_the_day_once(self):
        self.save()
        with closing(db.connect(self.path)) as conn:
            db.save_day(conn, self.day, [{**self.row, "boards": 3}], provider.CLS_SOURCE)
            db.set_settings(conn, range_end=self.day)
            self.assertIsNone(live_pool.snapshot(conn, self.day))
            self.assertFalse(live_pool.save_snapshot(conn, self.result(), now=self.now))
            self.assertNotIn(self.day, live_pool.metadata(conn)["dates"])
            self.assertEqual(db.meta(conn)["coverage"]["records"], 2)
        view = app.read_api(SimpleNamespace(db_path=self.path), "/api/date?date=" + self.day)
        self.assertFalse(view["provisional"])
        self.assertNotIn("live", view, "a confirmed close no longer reports a provisional pool waiting for updates")
        self.assertEqual(view["rows"][0]["boards"], 3)

    def run_refresh(self, result=None, *, dates=None, error=None):
        with patch.object(provider, "trading_dates", return_value=(dates or [self.previous, self.day], "calendar.json")) as calendar, \
             patch.object(provider, "fetch_live_day", return_value=result or self.result(), side_effect=error) as fetch:
            live_pool.refresh(self.path, now=self.now)
        return calendar, fetch

    def test_minute_refresh_uses_cached_calendar_and_has_no_dependency_on_archive_worker(self):
        calendar, fetch = self.run_refresh()
        calendar.assert_called_once()
        fetch.assert_called_once()
        calendar, fetch = self.run_refresh(self.result([{**self.row, "boards": 3}]))
        calendar.assert_not_called()
        fetch.assert_called_once()
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(live_pool.snapshot(conn, self.day)["records"][0]["boards"], 3)

    def test_holiday_and_outside_session_never_fetch_pool(self):
        _, fetch = self.run_refresh(dates=[self.previous])
        fetch.assert_not_called()
        with patch.object(provider, "fetch_live_day") as fetch, patch.object(provider, "trading_dates") as calendar:
            for time in ["08:59:00", "15:30:00", "23:00:00"]:
                live_pool.refresh(self.path, now=Clock.fromisoformat(f"{self.day}T{time}+08:00"))
            fetch.assert_not_called()
            calendar.assert_not_called()

    def test_empty_and_failure_keep_last_success_and_expose_state(self):
        self.save()
        self.run_refresh(provider.DayResult(self.day, [], "empty", "waiting", "empty.json"))
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(live_pool.metadata(conn)["status"], "waiting")
            self.assertEqual(live_pool.metadata(conn)["count"], 1)
        self.run_refresh(error=provider.ProviderError("offline"))
        with closing(db.connect(self.path)) as conn:
            meta = live_pool.metadata(conn)
            self.assertEqual(meta["status"], "error")
            self.assertEqual(meta["count"], 1)
            self.assertEqual(meta["error"], "offline")
            self.assertEqual(meta["fetched_at"], self.now.isoformat(timespec="seconds"))

    def test_calendar_failure_retries_instead_of_marking_holiday(self):
        with patch.object(provider, "trading_dates", side_effect=provider.ProviderError("calendar offline")):
            live_pool.refresh(self.path, now=self.now)
        with closing(db.connect(self.path)) as conn:
            self.assertNotIn("live_calendar_date", db.get_settings(conn))
        calendar, fetch = self.run_refresh()
        calendar.assert_called_once()
        fetch.assert_called_once()

    def test_not_yet_published_index_bar_is_rechecked_next_minute(self):
        _, fetch = self.run_refresh(dates=[self.previous])
        fetch.assert_not_called()
        calendar, fetch = self.run_refresh()
        calendar.assert_called_once()
        fetch.assert_called_once()

    def test_scheduler_and_minute_refresh_cutoffs_use_shanghai_time(self):
        self.assertEqual(live_pool.next_check_at(Clock.fromisoformat("2026-10-27T01:30:37+00:00")).isoformat(), "2026-10-27T09:31:00+08:00")
        self.assertEqual(live_pool.next_check_at(Clock.fromisoformat("2026-10-27T23:59:59+08:00")).isoformat(), "2026-10-28T00:00:00+08:00")
        self.assertTrue(live_pool.minute_refresh_due(self.day, "2026-10-27T09:59:00+08:00", now=self.now))
        self.assertFalse(live_pool.minute_refresh_due(self.day, "2026-10-27T09:59:30+08:00", now=self.now))
        self.assertFalse(live_pool.minute_refresh_due(self.previous, None, now=self.now))
        after = Clock.fromisoformat("2026-10-27T16:00:00+08:00")
        self.assertTrue(live_pool.minute_refresh_due(self.day, "2026-10-27T14:59:00+08:00", now=after))
        self.assertFalse(live_pool.minute_refresh_due(self.day, "2026-10-27T15:01:00+08:00", now=after))

    def test_current_minute_cache_advances_without_truncation_and_deduplicates_collection(self):
        self.save()
        points = [{"time": "09:30", "price": 11, "volume": 100, "amount": 1100}]
        with closing(intraday.connect(intraday.store_path(self.path))) as conn:
            with patch.object(db, "now_iso", return_value="2026-10-27T09:58:00+08:00"):
                intraday.save_session(conn, self.row, points, "synthetic", "old.json")
            conn.execute("INSERT INTO auctions VALUES (?,?,?,?,?,?,?,?)", (self.day, "600001", "unavailable", "[]", "", "synthetic", "", ""))
            conn.commit()
        payload = {"code": 0, "data": {"sh600001": {"data": [{"date": "20261027", "data": ["0930 11 100 1100", "0931 11 200 2200"]}]}}}
        with patch.object(intraday_sources, "fetch_json", return_value=(payload, "new.json")) as fetch, patch.object(db, "now_iso", return_value=self.now.isoformat()):
            detail = intraday_sources.collect_requested(self.path, self.day, "600001")
            self.assertEqual(len(detail["points"]), 2)
            intraday_sources.collect_requested(self.path, self.day, "600001")
            fetch.assert_called_once()
        with closing(intraday.connect(intraday.store_path(self.path))) as conn:
            self.assertFalse(intraday.save_session(conn, self.row, points, "synthetic", "truncated.json"))
        self.assertEqual(len(intraday.stock_view(self.path, self.day, "600001", include_live=True)["points"]), 2)

    def test_failed_minute_refresh_preserves_series_and_backs_off_until_next_minute(self):
        self.save()
        with closing(intraday.connect(intraday.store_path(self.path))) as conn:
            with patch.object(db, "now_iso", return_value="2026-10-27T09:58:00+08:00"):
                intraday.save_session(conn, self.row, [{"time": "09:30", "price": 11, "volume": 100, "amount": 1100}], "synthetic", "old.json")
            conn.execute("INSERT INTO auctions VALUES (?,?,?,?,?,?,?,?)", (self.day, "600001", "unavailable", "[]", "", "synthetic", "", ""))
            conn.commit()
        with patch.object(intraday_sources, "fetch_json", side_effect=ValueError("offline")) as fetch, patch.object(db, "now_iso", return_value=self.now.isoformat()):
            detail = intraday_sources.collect_requested(self.path, self.day, "600001")
            self.assertEqual(len(detail["points"]), 1)
            self.assertIn("offline", detail["refresh_error"])
            self.assertFalse(detail["needs_refresh"])
            intraday_sources.collect_requested(self.path, self.day, "600001")
            fetch.assert_called_once()


class LiveProviderTests(unittest.TestCase):
    def test_intraday_uses_current_date_and_does_not_use_history_endpoint(self):
        now = datetime.fromisoformat("2026-10-27T10:00:00+08:00")
        row = {"secu_code": "sh600001", "secu_name": "测试", "last_px": 11, "change": .1,
               "time": "2026-10-27 09:40:00", "num_stocks": 1, "limit_up_days": 2}
        response = SimpleNamespace(json=lambda: {"code": 200, "data": [row]})
        with patch.object(provider, "_get", return_value=response) as get, patch.object(provider, "_save_raw", return_value="test.json"):
            result = provider.fetch_live_day("2026-10-27", now=now)
            self.assertEqual(result.source, provider.CLS_SOURCE)
            self.assertEqual(get.call_args.kwargs["attempts"], 1)
            get.assert_called_once()
            with self.assertRaises(provider.ProviderError):
                provider.fetch_live_day("2026-10-26", now=now)
            get.assert_called_once()


if __name__ == "__main__":
    unittest.main()
