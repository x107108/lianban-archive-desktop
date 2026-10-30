"""Controller identities, disclosed parent ownership and cache replacement."""
from contextlib import closing
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

import control_owners as co
import database as db


def row(code="001219", controller=co.PARENT_OWNER_VIA, controller_id="10119054",
        actual=co.PARENT_OWNER_VIA, actual_id="10119054"):
    return {"SECUCODE": co.secucode(code), "SECURITY_CODE": code, "CONTROL_HOLDER": controller,
            "CONTROL_HOLDER_CODE": controller_id, "REAL_CONTROLER": actual, "REAL_CONTROLER_CODE": actual_id}


def payload(rows, pages=1, count=None):
    return {"success": True, "result": {"data": rows, "pages": pages, "count": len(rows) if count is None else count}}


class ControlOwnerTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")

    def tearDown(self):
        self.conn.close()

    def test_qingdao_parent_is_separate_from_disclosed_actual_controller(self):
        records, available, _, _ = co.normalize_page(payload([row()]), {"001219"})
        self.assertEqual(available, {"001219"})
        self.assertEqual([(r["kind"], r["holder_name"]) for r in records], [
            ("controller", co.PARENT_OWNER_VIA), ("actual_controller", co.PARENT_OWNER_VIA),
            ("parent_owner", co.PARENT_OWNER_NAME)])
        parent = records[-1]
        self.assertEqual(parent["via_name"], co.PARENT_OWNER_VIA)
        self.assertEqual(parent["holder_type"], "国资")
        self.assertEqual(parent["source_url"], co.PARENT_OWNER_URL)
        self.assertNotIn("report_date", parent)
        self.assertTrue(records[0]["source_url"].endswith("type=web&code=SZ001219"))
        changed = row(controller="新的控股机构", controller_id="10111111", actual="王甲", actual_id="王甲")
        records, *_ = co.normalize_page(payload([changed]), {"001219"})
        self.assertNotIn("parent_owner", [r["kind"] for r in records], "the parent edge follows the current controller, not the stock code")

    def test_multiple_entities_and_source_classification(self):
        value = row(controller="甲公司（境内,境外）,乙公司", controller_id="10001、10002",
                    actual="张三、李四", actual_id="张三、李四")
        records, *_ = co.normalize_page(payload([value]), {"001219"})
        self.assertEqual([r["holder_name"] for r in records], ["甲公司（境内,境外）", "乙公司", "张三", "李四"])
        self.assertEqual([r["holder_type"] for r in records], ["控股机构", "控股机构", "个人", "个人"])
        self.assertEqual(records[0]["holder_key"], "甲公司(境内,境外)")
        english = row(controller="COFCO Bio-chemical Investment Co., Ltd.", controller_id="10054902", actual="无", actual_id="无")
        records, *_ = co.normalize_page(payload([english]), {"001219"})
        self.assertEqual([r["holder_name"] for r in records], ["COFCO Bio-chemical Investment Co., Ltd."])
        mixed = row(controller="甲公司、CYPRESS CAMBO, L.P.", controller_id="10001、10002", actual="无", actual_id="无")
        records, *_ = co.normalize_page(payload([mixed]), {"001219"})
        self.assertEqual([r["holder_name"] for r in records], ["甲公司", "CYPRESS CAMBO, L.P."])
        gov = row(controller="未确认身份主体", controller_id=None,
                  actual="中华人民共和国财政部、国务院国资委", actual_id="10011644、10060361")
        records, *_ = co.normalize_page(payload([gov]), {"001219"})
        self.assertEqual([r["holder_type"] for r in records], ["控股主体", "国资", "国资"])

    def test_placeholders_never_create_shared_owners_and_empty_profile_is_distinct(self):
        for placeholder in [None, "无", "无控股股东", "无实际控制人", "不适用", "--"]:
            with self.subTest(placeholder=placeholder):
                records, available, *_ = co.normalize_page(payload([row(controller=placeholder, actual=placeholder)]), {"001219"})
                self.assertEqual(records, [])
                self.assertEqual(available, {"001219"})
        co.save_batch(self.conn, ["001219", "000001"], [], {"001219"})
        profiles = {r["code"]: r["source"] for r in self.conn.execute("SELECT * FROM stock_control_profiles")}
        self.assertEqual(profiles, {"001219": co.SOURCE, "000001": ""})

    def test_invalid_source_does_not_silently_become_an_empty_snapshot(self):
        bad_rows = [row(code="600600"), {**row(), "SECUCODE": "001219.SH"}, {**row(), "REAL_CONTROLER": 7},
                    {**row(), "REAL_CONTROLER": "张三、李四", "REAL_CONTROLER_CODE": "张三"}]
        missing = row()
        del missing["CONTROL_HOLDER"]
        bad_rows.append(missing)
        for bad in bad_rows:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                co.normalize_page(payload([bad]), {"001219"})
        with self.assertRaises(ValueError):
            co.normalize_page(payload([row(), row()]), {"001219"})
        with self.assertRaises(ValueError):
            co.normalize_page({"success": False, "message": "upstream unavailable"}, {"001219"})

    def test_failed_replacement_rolls_back_and_explicit_no_controller_clears(self):
        records, available, *_ = co.normalize_page(payload([row(), row(code="000001")]), {"001219", "000001"})
        co.save_batch(self.conn, ["001219", "000001"], records, available)
        before = [tuple(r) for r in self.conn.execute("SELECT * FROM stock_control_owners ORDER BY code,kind")]
        with self.assertRaisesRegex(ValueError, "保留缓存"):
            co.save_batch(self.conn, ["001219", "000001"], [], {"001219"})
        self.assertEqual([tuple(r) for r in self.conn.execute("SELECT * FROM stock_control_owners ORDER BY code,kind")], before)
        co.save_batch(self.conn, ["001219"], [], {"001219"})
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM stock_control_owners WHERE code='001219'").fetchone()[0], 0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM stock_control_owners WHERE code='000001'").fetchone()[0], 3)

    def test_fetch_checks_all_pages_and_does_not_accept_duplicates(self):
        root = Path(__file__).parent / "test-data" / ("control-source-" + uuid4().hex)
        def response(value):
            return io.BytesIO(json.dumps(value).encode())
        first = payload([row()], pages=2, count=2)
        second = payload([row(code="000001")], pages=2, count=2)
        with patch.object(co, "urlopen", side_effect=[response(first), response(second)]), patch.object(co.time, "sleep"):
            records, available = co.fetch_batch(["001219", "000001"], root)
        self.assertEqual(available, {"001219", "000001"})
        self.assertEqual(len(records), 6)
        for values, message in [([first, first], "重复"), ([first, payload([row(code="000001")])], "发生变化"),
                                ([payload([row()], count=2)], "未完整返回")]:
            with self.subTest(message=message), patch.object(co, "urlopen", side_effect=[response(v) for v in values]), patch.object(co.time, "sleep"), self.assertRaisesRegex(ValueError, message):
                co.fetch_batch(["001219", "000001"], root)

    def test_refresh_reuses_today_profiles_and_background_error_keeps_cache(self):
        path = Path(__file__).parent / "test-data" / ("control-refresh-" + uuid4().hex) / "archive.sqlite3"
        with closing(db.connect(path)) as conn:
            db.save_day(conn, "2026-10-29", [{"code": "001219", "name": "青岛食品", "boards": 1}], "synthetic")
        records, available, *_ = co.normalize_page(payload([row()]), {"001219"})
        with patch.object(co, "fetch_batch", return_value=(records, available)) as fetch:
            self.assertEqual(co.refresh(path), 1)
            self.assertEqual(co.refresh(path), 0)
            self.assertEqual(fetch.call_count, 1)
        with closing(db.connect(path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM stock_control_owners").fetchone()[0], 3)
            self.assertEqual(db.get_settings(conn)["control_owner_status"], "current")
            conn.execute("UPDATE stock_control_profiles SET fetched_at='2020-01-01T00:00:00+08:00'")
            conn.commit()
        refresher = co.Refresher(path)
        with patch.object(co, "fetch_batch", side_effect=OSError("offline")):
            refresher._run()
        with closing(db.connect(path)) as conn:
            self.assertEqual(db.get_settings(conn)["control_owner_status"], "error")
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM stock_control_owners").fetchone()[0], 3)


if __name__ == "__main__":
    unittest.main()
