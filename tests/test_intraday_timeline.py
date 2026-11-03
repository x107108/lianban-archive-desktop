from contextlib import closing
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import unittest
import http.client
import json
import threading
from unittest.mock import patch
from uuid import uuid4

import app
import database as db
import intraday
import intraday_sources
import intraday_timeline as timeline
import provider


def stock(code="000001", name="测试股", boards=2, **extra):
    return {"date": "2026-10-23", "code": code, "name": name, "boards": boards,
            "close": 11, "pct_change": 10, "first_time": None, "last_time": None, **extra}


def point(time, price=10, volume=10000):
    return {"time": time, "price": price, "volume": volume, "amount": price * volume}


class TimelineTests(unittest.TestCase):
    def test_clock_post_route_works_and_read_only_mode_rejects_collection(self):
        server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        server.db_path = Path("unused.sqlite3")
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with patch.object(timeline, "collect_seal_times", return_value={"date": "2026-10-23", "count": 2}) as collect:
                for read_only, expected in ((False, 200), (True, 403)):
                    server.read_only = read_only
                    client = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                    try:
                        client.request("POST", "/api/intraday/timeline/times", json.dumps({"date": "2026-10-23"}), {"Content-Type": "application/json"})
                        response = client.getresponse()
                        self.assertEqual(response.status, expected, response.read().decode())
                    finally:
                        client.close()
                collect.assert_called_once_with(server.db_path, "2026-10-23", force=False)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=3)

    def test_supplementary_seconds_are_cached_without_replacing_closing_facts(self):
        root = Path(__file__).parent / "test-data" / ("timeline-clocks-" + uuid4().hex)
        root.mkdir(parents=True)
        path, day = root / "archive.sqlite3", "2026-10-23"
        originals = [stock(boards=4), stock("600001"), stock("600002", first_time="09:40:01")]
        with closing(db.connect(path)) as conn:
            db.save_day(conn, day, originals, "财联社公开涨停池")
            before = [dict(r) for r in conn.execute("SELECT * FROM events ORDER BY code")]
        result = provider.DayResult(day, [stock(first_time="09:30:33", last_time="09:31:30"),
                                         stock("600001", close=12, first_time="09:31:01"),
                                         stock("600002", first_time="09:39:59")], "ok", "", "synthetic.json")
        with patch.object(provider, "_historical_day", return_value=result) as fetch:
            self.assertFalse(timeline.collect_seal_times(path, day)["cached"])
            self.assertTrue(timeline.collect_seal_times(path, day)["cached"])
            self.assertEqual(fetch.call_count, 1)
        with patch.object(provider, "_historical_day", side_effect=AssertionError("GET must stay offline")):
            data = timeline.timeline(path, day)
        pool = {row["code"]: row for row in data["pool"]}
        self.assertEqual(pool["000001"]["boards"], 4, "the original provider's board convention is retained")
        self.assertEqual(pool["000001"]["first_time"], "09:30:33")
        self.assertEqual(pool["000001"]["last_time"], "09:31:30")
        self.assertEqual(pool["000001"]["clock_source"], provider.SOURCE)
        self.assertIsNone(pool["600001"]["first_time"], "a closing-price mismatch cannot enrich another stock/day")
        self.assertEqual(pool["600002"]["first_time"], "09:40:01", "existing validated clocks are never replaced")
        self.assertTrue(any(e["time"] == "09:30:33" and e["precision"] == "source" for e in data["events"]))
        self.assertEqual(data["time_coverage"], {"cached": True, "missing": 1})
        for read_only in (False, True):
            with patch.object(provider, "_historical_day", side_effect=AssertionError("GET must stay offline")):
                daily = app.read_api(SimpleNamespace(db_path=path, read_only=read_only), "/api/date?date=" + day)
            daily_pool = {row["code"]: row for row in daily["rows"]}
            self.assertEqual(daily_pool["000001"]["first_time"], "09:30:33")
            self.assertEqual(daily_pool["000001"]["boards"], 4)
            self.assertIsNone(daily_pool["600001"]["first_time"])
            self.assertEqual(daily_pool["600002"]["first_time"], "09:40:01")
            self.assertEqual(daily["time_coverage"], {"cached": True, "missing": 1})
        with closing(db.connect(path)) as conn:
            self.assertEqual([dict(r) for r in conn.execute("SELECT * FROM events ORDER BY code")], before)
        with patch.object(provider, "_historical_day", return_value=provider.DayResult(day, [], "empty", "", "empty.json")):
            with self.assertRaises(ValueError):
                timeline.collect_seal_times(path, day, force=True)
        self.assertEqual(timeline.cached_seal_times(path, day)["stocks"]["000001"]["first_time"], "09:30:33", "an empty retry preserves previously verified seconds")
        with self.assertRaises(ValueError):
            timeline.collect_seal_times(path, "2026-10-22")

    def test_sources_are_kept_distinct_from_minute_observations(self):
        events = timeline.stock_events(stock(first_time="09:40:05", last_time="14:00:10"),
                                       [point("09:39"), point("09:40", 11), point("09:41", 10.9), point("09:42", 11)])
        self.assertEqual([(e["time"], e["kind"], e["precision"]) for e in events],
                         [("09:40:05", "seal", "source"), ("14:00:10", "last_seal", "source"),
                          ("09:41", "break", "minute"), ("09:42", "relock", "minute")])

    def test_only_adjacent_minutes_support_breaks_and_gaps_are_not_filled(self):
        events = timeline.stock_events(stock(), [point("09:30", 11), point("09:31", 10.9), point("09:32", 11),
                                                point("09:34", 10.8), point("11:30", 11), point("13:00", 10.8)])
        self.assertEqual([(e["kind"], e["time"]) for e in events], [("seal", "09:30"), ("break", "09:31"), ("relock", "09:32")])

    def test_volume_uses_past_median_and_never_double_counts_opening_match(self):
        points = [point(f"09:{30+i:02}", volume=10000) for i in range(6)]
        points[0]["volume"] = 500000
        points[-1]["volume"] = 100000
        original = deepcopy(points)
        auction = {"points": [{"time": "09:25", "volume": 490000}]}
        events = timeline.stock_events(stock(), points, auction)
        volume = [e for e in events if e["kind"] == "volume"]
        self.assertEqual([(e["time"], e["baseline"], e["ratio"]) for e in volume], [("09:35", 10000, 10)])
        self.assertEqual(points, original)
        self.assertFalse(any(e["kind"] == "volume" for e in timeline.stock_events(stock(), points, auction, multiple=20)))

    def test_zero_baselines_lunch_and_closing_auction_do_not_create_spikes(self):
        zeros = [point(f"09:{30+i:02}", volume=0) for i in range(5)] + [point("09:35", volume=500000)]
        lunch = [point(f"11:{26+i:02}") for i in range(5)] + [point("13:00", volume=500000)]
        close = [point(f"14:{55+i:02}") for i in range(5)] + [point("15:00", volume=500000)]
        for points in (zeros, lunch, close):
            self.assertFalse(any(e["kind"] == "volume" for e in timeline.stock_events(stock(), points)))

    def test_volume_phases_follow_first_seal_not_current_sealed_state(self):
        points = [point(f"09:{30+i:02}", price=11 if i == 10 else 10, volume=100000 if i in (5, 10, 11) else 10000) for i in range(12)]
        for first in ("09:40:25", None):
            events = timeline.stock_events(stock(first_time=first), points)
            spikes = [e for e in events if e["kind"] == "volume"]
            self.assertEqual([(e["time"], e["volume_phase"], e["label"]) for e in spikes],
                             [("09:35", "before", "涨停前放量"), ("09:40", "at", "涨停当分钟放量"), ("09:41", "after", "涨停后放量")])
            self.assertTrue(any(e["kind"] == "break" and e["time"] == "09:41" for e in events))
        auction_spikes = timeline.stock_events(stock(first_time="09:25:00"), points)
        self.assertEqual({e["volume_phase"] for e in auction_spikes if e["kind"] == "volume"}, {"after"})
        unknown = timeline.stock_events(stock(close=None), points)
        self.assertTrue(all(e["volume_phase"] == "unknown" for e in unknown if e["kind"] == "volume"))

    def test_rapid_moves_use_percentage_points_and_merge_each_wave(self):
        points = [point(f"09:{30+i:02}", price) for i, price in enumerate([10, 10.1, 10.2, 10.3, 10.45, 10.55, 10.3, 10.25, 10.2])]
        original = deepcopy(points)
        events = timeline.stock_events(stock(), points, previous_close=10)
        moves = [e for e in events if e["kind"].startswith("rapid_")]
        self.assertEqual([(e["kind"], e["time"], e["start_time"], e["change_pp"]) for e in moves],
                         [("rapid_up", "09:33", "09:30", 3), ("rapid_down", "09:37", "09:35", -3)])
        self.assertTrue(all(e["precision"] == "minute" for e in moves))
        self.assertEqual(points, original)
        high_start = timeline.rapid_moves([point("09:30", 22), point("09:31", 22.3), point("09:32", 22.6)], 20)
        self.assertEqual((high_start[0]["from_pct"], high_start[0]["to_pct"], high_start[0]["change_pp"]), (10, 13, 3), "3 points is measured against yesterday's close, not the wave's starting price")

    def test_rapid_moves_do_not_cross_gaps_lunch_or_the_five_minute_window(self):
        cases = [
            [point("09:30", 10), point("09:31", 10.29)],
            [point("09:30", 10), point("09:32", 10.4)],
            [point("11:30", 10), point("13:00", 10.5)],
            [point("09:25", 10), point("09:30", 10.5)],
            [point(f"09:{30+i:02}", 10 + i * .05) for i in range(7)],
        ]
        for points in cases:
            self.assertEqual(timeline.rapid_moves(points, 10), [])
        for reference in (None, 0):
            self.assertEqual(timeline.rapid_moves([point("09:30", 10), point("09:31", 10.5)], reference), [])
        boundary = timeline.rapid_moves([point(f"09:{30+i:02}", 10 + i * .06) for i in range(6)], 10)
        self.assertEqual((boundary[0]["time"], boundary[0]["duration_minutes"]), ("09:35", 5))

    def test_cached_timeline_passes_its_own_previous_close_to_rapid_detection(self):
        root = Path(__file__).parent / "test-data" / ("timeline-rapid-" + uuid4().hex)
        root.mkdir(parents=True)
        path, item = root / "archive.sqlite3", stock()
        with closing(db.connect(path)) as conn:
            db.save_day(conn, item["date"], [item], "synthetic")
        points = [point("09:30", 10), point("09:31", 10.3)]
        with closing(intraday.connect(intraday.store_path(path))) as conn:
            intraday.save_session(conn, item, points, "synthetic", "test.json")
        with patch("requests.get", side_effect=AssertionError("derived nodes must reuse the local cache")):
            result = timeline.timeline(path, item["date"])
        rapid = [e for e in result["events"] if e["kind"] == "rapid_up"]
        self.assertEqual([(e["time"], e["change_pp"]) for e in rapid], [("09:31", 3)])

    def test_association_is_chronological_bounded_and_never_self_causal(self):
        anchor = timeline.stock_events(stock(first_time="09:40:05"), [])[0]
        changes = [dict(anchor, id="peer-before", code="600001", kind="volume", time="09:38", minute=578),
                   dict(anchor, id="peer-after", code="600002", kind="break", time="09:42", minute=582),
                   dict(anchor, id="too-far", code="600003", kind="break", time="09:43", minute=583),
                   dict(anchor, id="same-stock", kind="break", time="09:41", minute=581)]
        events = timeline.associate([changes[2], anchor, *changes[:2], changes[3]], 2)
        result = next(e for e in events if e["id"] == anchor["id"])
        self.assertEqual([(e["id"], e["delta"]) for e in result["related"]], [("peer-before", -2), ("peer-after", 2)])
        self.assertEqual([e["minute"] for e in events], sorted(e["minute"] for e in events))

    def test_invalid_or_lunch_source_times_and_missing_limit_prices_are_safe(self):
        events = timeline.stock_events(stock(close=None, first_time="12:00:00", last_time="99:00:00"), [point("09:30", 11), point("09:31", 10)])
        self.assertEqual(events, [])

    def test_auction_nodes_are_removed_without_relabeling_them_as_regular_trading(self):
        events = timeline.stock_events(stock(first_time="09:25:00", last_time="09:25:00"),
                                       [point("09:30", 11), point("09:31", 11)])
        self.assertEqual(events, [], "an auction seal is not replaced with an invented 09:30 seal")
        anchor = timeline.stock_events(stock(first_time="09:30:00"), [])[0]
        auction = dict(anchor, id="old-auction", code="600001", time="09:25:00", minute=565)
        peer = dict(anchor, id="peer-volume", code="600002", kind="volume", time="09:30", minute=570)
        regular = timeline.associate([auction, anchor, peer], 5)
        self.assertNotIn("old-auction", [event["id"] for event in regular])
        self.assertTrue(all(event["time"] >= "09:30" for event in regular))
        # Legacy nested auction records must not leak into grouped evidence either.
        anchor["related"] = [auction, peer]
        auction["related"] = [anchor]
        groups = timeline.interaction_groups([auction, anchor, peer], 5)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["start"], "09:30")
        self.assertEqual({event["id"] for event in groups[0]["events"]}, {anchor["id"], peer["id"]})

    def test_isolated_and_same_stock_events_do_not_qualify_but_multiple_seals_do(self):
        first = timeline.stock_events(stock(first_time="09:40:05"), [])[0]
        second = timeline.stock_events(stock("600001", first_time="09:40:15"), [])[0]
        own_volume = dict(first, id="own-volume", kind="volume", time="09:41", minute=581)
        groups = timeline.interaction_groups(timeline.associate([first, second], 2), 2)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["kinds"], ["simultaneous"])
        self.assertEqual(groups[0]["stock_count"], 2)
        self.assertEqual(timeline.interaction_groups(timeline.associate([first, own_volume], 2), 2), [])

    def test_cross_stock_pairs_merge_in_one_bounded_time_period_with_evidence(self):
        first = timeline.stock_events(stock(first_time="09:40:05"), [])[0]
        second = timeline.stock_events(stock("600002", first_time="09:41:15"), [])[0]
        change = dict(first, id="peer-break", code="600001", kind="break", time="09:41", minute=581, precision="minute")
        volume = dict(change, id="peer-volume", kind="volume", time="09:42", minute=582)
        events = timeline.associate([volume, first, change, second], 2)
        original = deepcopy(events)
        groups = timeline.interaction_groups(events, 2)
        self.assertEqual(len(groups), 1)
        group = groups[0]
        self.assertEqual((group["start"], group["end"], group["stock_count"]), ("09:40", "09:42", 3))
        self.assertEqual(group["kinds"], ["break", "simultaneous", "volume"])
        self.assertEqual(len(group["links"]), 5)
        self.assertEqual(len(group["events"]), 4, "shared peer evidence is included once")
        self.assertEqual(group["events"][0]["time"], "09:40:05")
        self.assertTrue(all("related" not in event for event in group["events"]))
        self.assertEqual(events, original, "grouping does not rewrite source observations")

    def test_simultaneous_seals_keep_actual_times_and_do_not_duplicate_reverse_pairs(self):
        first = timeline.stock_events(stock(first_time="09:40:05"), [])[0]
        second = timeline.stock_events(stock("600001", first_time="09:40:20"), [])[0]
        later = timeline.stock_events(stock("600002", first_time="09:41:00"), [])[0]
        groups = timeline.interaction_groups(timeline.associate([later, second, first], 0), 0)
        self.assertEqual(len(groups), 1)
        self.assertEqual([event["time"] for event in groups[0]["events"]], ["09:40:05", "09:40:20"])
        self.assertEqual(groups[0]["start"], groups[0]["end"])
        self.assertEqual(groups[0]["links"], [{"anchor_id": first["id"], "event_id": second["id"], "delta": 0, "kind": "simultaneous"}])
        wider = timeline.interaction_groups(timeline.associate([later, second, first], 1), 1)
        self.assertEqual(wider[0]["stock_count"], 3)
        self.assertEqual(len(wider[0]["links"]), 3, "each cross-stock sealing pair appears in only one direction")

    def test_neighboring_pairs_do_not_transitively_merge_across_the_session(self):
        anchors = [timeline.stock_events(stock(f"00000{i+1}", first_time=f"09:{40+i:02}:05"), [])[0] for i in range(7)]
        changes = [dict(anchors[0], id=f"volume-{i}", code="600001", kind="volume", time=f"09:{39+i:02}", minute=579+i) for i in range(9)]
        groups = timeline.interaction_groups(timeline.associate([*reversed(anchors), *changes], 1), 1)
        self.assertGreater(len(groups), 1)
        self.assertEqual([group["minute"] for group in groups], sorted(group["minute"] for group in groups))
        for group in groups:
            self.assertGreaterEqual(group["stock_count"], 2)
            self.assertLessEqual(group["end_minute"] - group["minute"], 2)
            members = {event["id"]: event for event in group["events"]}
            for link in group["links"]:
                self.assertNotEqual(members[link["anchor_id"]]["code"], members[link["event_id"]]["code"])
                self.assertLessEqual(abs(link["delta"]), 1)

    def test_read_route_is_offline_and_reports_uncached_eligible_pool(self):
        root = Path(__file__).parent / "test-data" / ("timeline-" + uuid4().hex)
        root.mkdir(parents=True)
        path = root / "archive.sqlite3"
        with closing(db.connect(path)) as conn:
            db.save_day(conn, "2026-10-23", [stock(first_time="09:40:05"), stock("600001", "*ST测试"), stock("600002", " st 测试"),
                                           stock("300001", "创业板", first_time="09:40:20"), stock("301001", "创业板二", first_time="09:40:40"),
                                           stock("300002", "*ST创业"), stock("688001", "科创板")], "synthetic")
            db.save_stock_tags(conn, "000001", ["自定义标签", "机器人"], 0)
            db.save_stock_tags(conn, "300001", ["创业标签"], 0)
        with patch("requests.get", side_effect=AssertionError("timeline reads must stay offline")):
            result = app.read_api(SimpleNamespace(db_path=path), "/api/intraday/timeline?date=2026-10-23&window=2&multiple=10")
        self.assertEqual(result["coverage"], {"total": 1, "analyzed": 0, "partial": 0, "missing": 1})
        self.assertEqual(result["scope"], {"start_time": "09:30", "exclude_st": True, "exclude_gem": True})
        self.assertEqual([stock["code"] for stock in result["pool"]], ["000001"], "ST, *ST and both 300/301 boards are excluded from picker options")
        self.assertEqual(result["pool"][0]["tags"], ["自定义标签", "机器人"])
        self.assertEqual([e["code"] for e in result["events"]], ["000001"])
        self.assertEqual(result["interactions"], [], "an uncached single-stock seal is not a multi-stock interaction")
        self.assertEqual(result["jobs"], [{"code": "000001", "name": "测试股", "force": False}])
        self.assertFalse(intraday.store_path(path).exists())
        with patch("requests.get", side_effect=AssertionError("scope changes must stay offline")):
            expanded = app.read_api(SimpleNamespace(db_path=path), "/api/intraday/timeline?date=2026-10-23&exclude_gem=0&exclude_st=0")
        self.assertEqual(expanded["scope"], {"start_time": "09:30", "exclude_st": True, "exclude_gem": False})
        self.assertEqual({stock["code"] for stock in expanded["pool"]}, {"000001", "300001", "301001"})
        self.assertEqual(next(stock for stock in expanded["pool"] if stock["code"] == "300001")["tags"], ["创业标签"])
        self.assertEqual({job["code"] for job in expanded["jobs"]}, {"000001", "300001", "301001"}, "GEM stocks use the selected-day collection queue when enabled")
        self.assertEqual(expanded["interactions"][0]["stock_count"], 3)
        self.assertEqual(intraday.stock_view(path, "2026-10-23", "300001")["stock"]["name"], "创业板", "timeline GEM stocks can be opened for minute viewing")
        self.assertEqual(timeline.timeline(path, "2026-10-23", window=0)["window"], 0)
        self.assertEqual(app.read_api(SimpleNamespace(db_path=path), "/api/intraday/timeline?date=2026-10-23")["multiple"], 10)
        for multiple in range(10, 101, 10):
            result = app.read_api(SimpleNamespace(db_path=path), f"/api/intraday/timeline?date=2026-10-23&multiple={multiple}")
            self.assertEqual(result["multiple"], multiple)
        for query in ("window=-1", "window=99", "multiple=nan", "multiple=9", "multiple=101", "exclude_gem=yes"):
            with self.assertRaises(ValueError):
                app.read_api(SimpleNamespace(db_path=path), "/api/intraday/timeline?date=2026-10-23&" + query)
        intraday_sources.save_catalog(path, [{"code": "000001", "name": "ST当前股"}], 1)
        self.assertEqual(timeline.timeline(path, "2026-10-23")["coverage"]["total"], 0)


if __name__ == "__main__":
    unittest.main()
