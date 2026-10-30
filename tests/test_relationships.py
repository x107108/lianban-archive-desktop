"""Relationship semantics using synthetic fixtures, never live market claims."""
from __future__ import annotations

import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
import database as db


def event(code="600001", name="测试甲", boards=2):
    return {"code": code, "name": name, "boards": boards}


class RelationshipTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        self.start, self.end = "2026-07-23", "2026-07-30"
        db.set_settings(self.conn, range_start=self.start, range_end=self.end,
                        calendar_dates=["2026-07-23", "2026-07-24", "2026-07-27", "2026-07-28",
                                        "2026-07-29", "2026-07-30", "2026-07-31"])

    def tearDown(self):
        self.conn.close()

    def save(self, day, rows, **kwargs):
        db.save_day(self.conn, day, rows, "synthetic-test", **kwargs)

    def relations(self, code="600001", start=None, end=None):
        return db.stock_view(self.conn, code, start or self.start, end or self.end)["relationships"]

    def test_win_and_reverse_loss_keep_pending_evidence(self):
        self.save(self.start, [event(), event("000001", "对手乙")])
        self.save("2026-07-24", [event(boards=3)])
        won = self.relations()["competition"]
        lost = self.relations("000001")["competition"]
        self.assertEqual([(r["code"], r["count"]) for r in won["wins"]], [("000001", 1)])
        self.assertEqual([(r["code"], r["count"]) for r in lost["losses"]], [("600001", 1)])
        evidence = won["wins"][0]["rounds"][0]
        self.assertEqual((evidence["date"], evidence["next_date"], evidence["boards"]),
                         ("2026-07-23", "2026-07-24", 2))
        self.assertEqual(evidence["verification"], "pending")
        self.assertEqual(evidence["evidence"], "promotion_vs_not_in_pool")

    def test_repeated_rival_keeps_wins_and_losses_separately(self):
        for day in ("2026-07-23", "2026-07-27", "2026-07-29"):
            self.save(day, [event(), event("000001", "对手乙")])
        self.save("2026-07-24", [event(boards=3)])
        self.save("2026-07-28", [event("000001", "对手乙", 3)])
        self.save("2026-07-30", [event(boards=3)])
        result = self.relations()["competition"]
        self.assertEqual(result["win_count"], 2)
        self.assertEqual(result["loss_count"], 1)
        self.assertEqual(result["wins"][0]["count"], 2)
        self.assertEqual(result["losses"][0]["count"], 1)
        self.assertEqual([r["date"] for r in result["wins"][0]["rounds"]], ["2026-07-29", "2026-07-23"])

    def test_current_peer_profiles_keep_historical_names_and_pending_results(self):
        self.save(self.start, [event(), event("000001", "历史对手")])
        self.save("2026-07-24", [event(boards=3)])
        self.save("2026-07-30", [event("000001", "后续名称", 1)])
        db.save_industries(self.conn, [{"code": "000001", "industry": "传媒",
            "industry_level2": "出版", "industry_level3": "图书", "industry_code": "test",
            "effective_from": "2026-07-30", "source_updated_at": "2026-07-30"}],
            "synthetic-current", "2026-07-30", [])
        db.save_registrations(self.conn, [{"code": "000001", "province": "天津", "city": "天津",
            "location": "天津", "address": "测试注册地址"}], "synthetic-current", "2026-07-30", [], 1)
        db.save_stock_tags(self.conn, "000001", ["传媒", "自定义标签"], 0)
        facts_before = [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")]
        result = self.relations(end="2026-07-24")["competition"]
        for peer in (result["wins"][0], result["rounds"][-1]["wins"][0]):
            self.assertEqual(peer["name"], "历史对手")
            self.assertEqual(peer["initials"], "LSDS")
            self.assertEqual(peer["industry"], "传媒")
            self.assertEqual(peer["registered_province"], "天津市")
            self.assertTrue({"registered_location", "registered_city", "registered_address"}.isdisjoint(peer))
            self.assertEqual(peer["tags"], ["传媒", "自定义标签"])
            self.assertTrue(peer["tags_customized"])
        self.assertEqual(result["win_round_count"], 1)
        self.assertEqual(result["wins"][0]["rounds"][0]["verification"], "pending")
        self.assertEqual(facts_before, [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")])

    def test_common_only_peer_has_initials_and_current_custom_tags(self):
        self.save(self.start, [event(), event("000530", "冰山冷热", 4)])
        self.save("2026-07-24", [event(boards=3)])
        db.save_stock_tags(self.conn, "000530", ["军工", "液冷"], 0)
        facts_before = [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")]
        relations = self.relations()
        self.assertEqual(relations["competition"]["wins"], [])
        self.assertEqual(relations["competition"]["losses"], [])
        peer = relations["cooccurrences"]["rows"][0]
        self.assertEqual(peer["initials"], "BSLR")
        self.assertEqual(peer["tags"], ["军工", "液冷"])
        self.assertTrue(peer["tags_customized"])
        self.assertEqual(peer["dates"][0]["peer_boards"], 4)
        self.assertEqual(facts_before, [tuple(row) for row in self.conn.execute("SELECT * FROM events ORDER BY date,code")])

    def test_peer_without_profile_does_not_invent_location_or_industry(self):
        self.save(self.start, [event(), event("000001", "对手乙")])
        self.save("2026-07-24", [event("000001", "对手乙", 3)])
        result = self.relations(end="2026-07-24")["competition"]
        for peer in (result["losses"][0], result["rounds"][0]["losses"][0]):
            self.assertFalse(peer.get("industry"))
            self.assertFalse(peer.get("registered_location"))
            self.assertEqual(peer["tags"], [])
            self.assertFalse(peer["tags_customized"])

    def test_common_days_count_all_markets_and_heights_once_per_stock_per_day(self):
        self.save(self.start, [event(), event("000001", "对手乙"), event("300001", "其他板块", 5)])
        self.save("2026-07-24", [event(boards=3), event("000001", "对手乙", 3), event("300001", "其他板块", 1)])
        self.save("2026-07-27", [event("000001", "对手乙", 4)])
        result = self.relations()
        common = result["cooccurrences"]["rows"]
        self.assertEqual([(r["code"], r["count"]) for r in common], [("000001", 2), ("300001", 2)])
        self.assertEqual(result["target_limit_days"], 2)
        self.assertNotIn("600001", [row["code"] for row in common])
        self.assertEqual(common[1]["dates"][0], {"date": "2026-07-24", "target_boards": 3, "peer_boards": 1})
        self.assertEqual(result["competition"]["win_count"], 0)

    def test_weekend_uses_next_trading_day(self):
        self.save("2026-07-24", [event(), event("000001", "对手乙")])
        self.save("2026-07-27", [event(boards=3)])
        rounds = self.relations()["competition"]["wins"][0]["rounds"]
        self.assertEqual(rounds[0]["next_date"], "2026-07-27")

    def test_failed_and_never_fetched_days_do_not_skip_to_later_success(self):
        for attempted in (False, True):
            with self.subTest(attempted=attempted):
                self.save(self.start, [event(), event("000001", "对手乙")])
                if attempted:
                    self.save("2026-07-24", [], status="failed")
                self.save("2026-07-27", [event(boards=3)])
                result = self.relations()["competition"]
                self.assertEqual((result["win_count"], result["loss_count"]), (0, 0))
                affected = next(row for row in result["rounds"] if row["date"] == self.start)
                self.assertEqual(affected["status"], "missing")
                self.assertEqual(affected["next_date"], "2026-07-24")

    def test_cutoff_does_not_reveal_later_results_or_names(self):
        self.save(self.start, [event(), event("000001", "历史名称")])
        self.save("2026-07-24", [event(boards=3), event("000001", "后续名称", 3)])
        result = self.relations(end=self.start)
        self.assertEqual(result["competition"]["rounds"][0]["status"], "cutoff")
        self.assertIsNone(result["competition"]["rounds"][0]["next_date"])
        self.assertEqual(result["cooccurrences"]["rows"][0]["name"], "历史名称")
        self.assertNotIn("后续名称", json.dumps(result, ensure_ascii=False))
        self.assertEqual(result["competition"]["win_count"], 0)

    def test_both_competition_dates_must_be_in_period(self):
        self.save(self.start, [event(), event("000001", "对手乙")])
        self.save("2026-07-24", [event(boards=3)])
        result = self.relations(start="2026-07-24")
        self.assertEqual(result["competition"]["wins"], [])
        self.assertEqual(result["cooccurrences"]["rows"], [])

    def test_competition_uses_all_markets_and_st_but_keeps_heights_separate(self):
        self.save(self.start, [event(), event("000001", "同级乙"), event("300001", "创业板", 2),
                               event("688001", "科创板", 2), event("600002", "ST风险股", 2),
                               event("830001", "北交所", 2),
                               event("000002", "不同高度", 1)])
        self.save("2026-07-24", [event(boards=3)])
        expected = {"600001", "000001", "300001", "688001", "600002", "830001"}
        result = self.relations(end="2026-07-24")
        competition = result["competition"]
        self.assertEqual({r["code"] for r in competition["wins"]}, expected - {"600001"})
        self.assertEqual((competition["win_count"], competition["win_round_count"]), (5, 1))
        round_record = next(r for r in competition["rounds"] if r["date"] == self.start)
        self.assertEqual({p["code"] for p in round_record["cohort"]}, expected)
        self.assertEqual(round_record["peer_count"], 5)
        self.assertEqual(result["cooccurrences"]["stock_count"], 6)
        for code in expected - {"600001"}:
            with self.subTest(code=code):
                reverse = self.relations(code, end="2026-07-24")["competition"]
                self.assertEqual([r["code"] for r in reverse["losses"]], ["600001"])
                self.assertEqual((reverse["loss_count"], reverse["loss_round_count"]), (1, 1))
                self.assertEqual({p["code"] for p in reverse["rounds"][0]["cohort"]}, expected)

    def test_historical_st_names_retained_while_st_and_ordinary_stocks_share_cohort(self):
        self.save(self.start, [event("600001", "ST测试甲"), event("000001", "*ST测试乙"), event("000002", "普通股")])
        self.save("2026-07-24", [event("600001", "ST测试甲", 3)])
        self.save("2026-07-30", [event("000001", "摘帽名称", 1)])
        result = self.relations(end="2026-07-24")["competition"]
        self.assertEqual([r["code"] for r in result["wins"]], ["000001", "000002"])
        self.assertEqual(result["wins"][0]["name"], "*ST测试乙")

    def test_gem_promotion_has_symmetric_wins_over_main_and_star_stocks(self):
        self.save(self.start, [event(), event("300001", "创业板"), event("688001", "科创板")])
        self.save("2026-07-24", [event("300001", "创业板", 3)])
        gem = self.relations("300001", end="2026-07-24")["competition"]
        self.assertEqual({r["code"] for r in gem["wins"]}, {"600001", "688001"})
        self.assertEqual((gem["win_count"], gem["win_round_count"]), (2, 1))
        for code in ("600001", "688001"):
            lost = self.relations(code, end="2026-07-24")["competition"]
            self.assertEqual([r["code"] for r in lost["losses"]], ["300001"])
            self.assertEqual(lost["rounds"][0]["peer_count"], 2)

    def test_both_promoting_or_both_absent_create_no_win_or_loss(self):
        self.save(self.start, [event(), event("000001", "对手乙")])
        self.save("2026-07-24", [event(boards=3), event("000001", "对手乙", 3)])
        self.save("2026-07-27", [])
        result = self.relations()["competition"]
        self.assertEqual(result["wins"], [])
        self.assertEqual(result["losses"], [])
        self.assertEqual(result["rounds"][-1]["together_count"], 1)

    def test_contradictory_board_reset_is_not_misclassified_as_a_loss(self):
        self.save(self.start, [event(), event("000001", "对手乙")])
        self.save("2026-07-24", [event(boards=3), event("000001", "对手乙", 1)])
        self.assertEqual(self.relations()["competition"]["wins"], [])
        self.assertEqual(self.relations("000001")["competition"]["losses"], [])

    def test_source_correction_recomputes_relationships(self):
        self.save(self.start, [event(), event("000001", "对手乙")])
        self.save("2026-07-24", [event(boards=3)])
        self.assertEqual(self.relations()["competition"]["win_count"], 1)
        self.save("2026-07-24", [event(boards=3), event("000001", "对手乙", 3)])
        self.assertEqual(self.relations()["competition"]["win_count"], 0)

    def test_counts_sorted_and_unknown_stock_is_empty(self):
        self.save(self.start, [event(), event("000001", "对手乙"), event("000002", "对手丙")])
        self.save("2026-07-24", [event(boards=3), event("000002", "对手丙", 3)])
        rows = self.relations()["cooccurrences"]["rows"]
        self.assertEqual([(row["code"], row["count"]) for row in rows], [("000002", 2), ("000001", 1)])
        unknown = self.relations("999999")
        self.assertEqual(unknown["target_limit_days"], 0)
        self.assertEqual(unknown["competition"]["rounds"], [])
        self.assertEqual(unknown["cooccurrences"]["rows"], [])

    def test_stock_api_includes_both_relationship_types(self):
        self.save(self.start, [event(), event("000001", "对手乙")])
        self.save("2026-07-24", [event(boards=3)])
        handler = object.__new__(app.Handler)
        handler.path = "/api/stock?code=600001&start=2026-07-23&end=2026-07-24"
        handler.server = SimpleNamespace(db_path=":memory:")
        handler.wfile = io.BytesIO()
        response = {}
        handler.send_response = lambda status: response.update(status=status)
        handler.send_header = lambda key, value: None
        handler.end_headers = lambda: None
        copied = db.connect(":memory:")
        self.conn.backup(copied)
        with patch.object(app.db, "connect", return_value=copied):
            handler.do_GET()
        self.assertEqual(response["status"], 200)
        result = json.loads(handler.wfile.getvalue())["relationships"]
        self.assertEqual(result["competition"]["win_count"], 1)
        self.assertEqual(result["cooccurrences"]["rows"][0]["count"], 1)

    def test_four_to_five_counts_one_batch_with_multiple_losing_opponents(self):
        self.save(self.start, [event(boards=4), event("000001", "对手乙", 4),
                               event("000002", "对手丙", 4), event("000003", "对手丁", 4)])
        self.save("2026-07-24", [event(boards=5)])
        result = self.relations(end="2026-07-24")["competition"]
        self.assertEqual(result["win_round_count"], 1)
        self.assertEqual(result["win_count"], 3)  # Opponent evidence count stays separate.
        batch = next(row for row in result["rounds"] if row["date"] == self.start)
        self.assertEqual((batch["boards"], batch["target_next_boards"], batch["outcome"]), (4, 5, "win"))
        self.assertEqual(len(batch["wins"]), 3)
        self.assertEqual(self.relations("000001", end="2026-07-24")["competition"]["loss_round_count"], 1)

    def test_all_board_heights_are_retained_as_separate_rounds(self):
        for day, height, peers in [
            ("2026-07-23", 2, [("000001", "对手乙"), ("000002", "对手丙")]),
            ("2026-07-24", 3, [("000002", "对手丙"), ("000003", "对手丁")]),
            ("2026-07-27", 4, [("000003", "对手丁"), ("000004", "对手戊")]),
            ("2026-07-28", 5, [("000004", "对手戊")]),
            ("2026-07-29", 6, []),
        ]:
            self.save(day, [event(boards=height)] + [event(code, name, height) for code, name in peers])
        result = self.relations(end="2026-07-29")["competition"]
        self.assertEqual(result["win_round_count"], 4)
        self.assertEqual({row["boards"] for row in result["rounds"]}, {2, 3, 4, 5, 6})
        self.assertEqual({row["boards"] for row in result["rounds"] if row["outcome"] == "win"}, {2, 3, 4, 5})

    def test_multiple_promoting_opponents_count_one_lost_batch(self):
        self.save(self.start, [event(boards=3), event("000001", "对手乙", 3), event("000002", "对手丙", 3)])
        self.save("2026-07-24", [event("000001", "对手乙", 4), event("000002", "对手丙", 4)])
        result = self.relations(end="2026-07-24")["competition"]
        self.assertEqual(result["loss_round_count"], 1)
        self.assertEqual(result["loss_count"], 2)
        self.assertEqual(result["rounds"][0]["outcome"], "loss")

    def test_cutoff_explains_empty_loss_without_counting_next_day_until_extended(self):
        self.save(self.start, [event(boards=3), event("000001", "对手乙", 3)])
        self.save("2026-07-24", [event("000001", "对手乙", 4)])
        cutoff = self.relations(end=self.start)["competition"]
        self.assertEqual(cutoff["loss_round_count"], 0)
        self.assertEqual(cutoff["next_result_date"], "2026-07-24")
        self.assertIn("超出当前数据收录范围", cutoff["empty_reasons"]["losses"])
        self.assertIn("3 进 4", cutoff["empty_reasons"]["losses"])
        self.assertEqual(cutoff["rounds"][0]["outcome"], "cutoff")
        self.assertNotIn("对手乙", cutoff["empty_reasons"]["losses"])
        extended = self.relations(end="2026-07-24")["competition"]
        self.assertEqual(extended["loss_round_count"], 1)
        self.assertEqual(extended["losses"][0]["code"], "000001")
        self.assertEqual(extended["empty_reasons"]["losses"], "")

    def test_unopposed_board_is_visible_without_counting_a_win(self):
        self.save(self.start, [event(boards=4)])
        self.save("2026-07-24", [event(boards=5)])
        result = self.relations(end="2026-07-24")["competition"]
        self.assertEqual(result["win_round_count"], 0)
        self.assertEqual(result["pending_rounds"], 0)
        self.assertEqual(len(result["rounds"]), 2)
        self.assertTrue(all(row["outcome"] == "no_peers" for row in result["rounds"]))
        self.assertIn("未发现同日同板数", result["empty_reasons"]["wins"])

    def test_missing_result_explains_empty_lists_instead_of_claiming_no_losses(self):
        self.save(self.start, [event(), event("000001", "对手乙")])
        self.save("2026-07-24", [], status="failed")
        result = self.relations(end="2026-07-24")["competition"]
        self.assertEqual(result["pending_rounds"], 1)
        self.assertEqual(result["loss_round_count"], 0)
        self.assertIn("数据未确认", result["empty_reasons"]["losses"])
        self.assertIsNone(result["next_result_date"])


if __name__ == "__main__":
    unittest.main()
