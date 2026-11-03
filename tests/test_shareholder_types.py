"""Classifications of corporate entities, verified AMCs and account exclusions."""
from contextlib import closing
import unittest

import database as db
import shareholders as sh
import control_owners as control
from shareholder_types import classify_holder


class ShareholderTypeTests(unittest.TestCase):
    def test_huijin_is_distinct_from_other_state_holders_and_fund_products(self):
        for name in ("中央汇金投资有限责任公司", "中央汇金资产管理有限责任公司"):
            self.assertEqual(classify_holder(name, "国家队"), "中央汇金")
        self.assertEqual(classify_holder("中国证券金融股份有限公司", "国家队"), "国家队")
        self.assertEqual(classify_holder("华夏基金-中央汇金资产管理有限责任公司-某资产管理计划", "基金"), "基金")
        self.assertEqual(classify_holder("上海汇金投资管理有限公司", "其他"), "其他")

    def test_huijin_refinement_is_shared_by_cached_lists_and_date_alerts(self):
        with closing(db.connect(":memory:")) as conn:
            day = "2026-11-02"
            db.save_day(conn, day, [{"code": code, "name": code, "boards": 1}
                        for code in ("000001", "000002")], "synthetic")
            records = [{"code": code, "holder_key": "中央汇金资产管理有限责任公司",
                        "holder_name": "中央汇金资产管理有限责任公司", "holder_type": "国家队",
                        "report_date": "2026-09-30"} for code in ("000001", "000002")]
            sh.save_batch(conn, ["000001", "000002"], {"total": records, "float": records})
            result = sh.stock_view(conn, "000001", day=day)
            self.assertEqual(result["own_holders"]["total"][0]["type"], "中央汇金")
            self.assertEqual(result["rows"][0]["holders"][0]["type"], "中央汇金")
            self.assertEqual(sh.date_alerts(conn, day)["rows"], [
                {"code": "000001", "types": ["中央汇金"]}, {"code": "000002", "types": ["中央汇金"]}])
            self.assertEqual({r[0] for r in conn.execute("SELECT holder_type FROM stock_shareholders")}, {"国家队"})

    def test_verified_amcs_keep_old_names_and_branches_without_inheriting_to_products(self):
        for name in ("中国长城资产管理股份有限公司", "中国长城资产管理公司",
                     "中国东方资产管理股份有限公司江西省分公司", "中国华融资产管理股份有限公司",
                     "中国中信金融资产管理股份有限公司北京市分公司", "中国银河资产管理有限责任公司",
                     "江苏资产管理有限公司", "湖北省资产管理有限公司"):
            self.assertEqual(classify_holder(name, "其他"), "AMC")
        for name in ("上海景林资产管理有限公司", "中国长城资产管理股份有限公司-客户资金",
                     "中国长城资产管理股份有限公司旗下投资基金", "某某资产管理有限公司"):
            self.assertEqual(classify_holder(name, "其他"), "其他")

    def test_corporate_legal_forms_are_distinct_from_products_and_nominee_accounts(self):
        for name in ("深圳市核子基因科技有限公司", "青岛煜禾投资有限公司", "某某集团有限责任公司",
                     "汕头市新联新投资合伙企业(有限合伙)"):
            self.assertEqual(classify_holder(name, "其他"), "企业股东")
        for name in ("某基金管理有限公司-某产品", "某私募投资合伙企业(有限合伙)",
                     "香港中央结算(代理人)有限公司", "某银行股份有限公司", "某证券投资管理有限公司",
                     "青岛食品股份有限公司未确权股份托管专用证券账户", "某医药检验实验室"):
            self.assertEqual(classify_holder(name, "其他"), "其他")
        self.assertEqual(classify_holder("香港中央结算有限公司", "其他"), "香港中央结算有限公司")
        for source in ("个人", "基金", "保险", "券商", "国家队", "国资", "控股机构", "QFII"):
            self.assertEqual(classify_holder("某某有限公司", source), source)

    def test_existing_cache_lists_peer_matches_and_alerts_share_the_same_read_time_types(self):
        with closing(db.connect(":memory:")) as conn:
            day = "2026-11-02"
            db.save_day(conn, day, [{"code": code, "name": code, "boards": 1}
                        for code in ("000001", "000002")], "synthetic")
            names = ("深圳市核子基因科技有限公司", "中国长城资产管理股份有限公司")
            records = [{"code": code, "holder_key": name, "holder_name": name, "holder_type": "其他",
                        "report_date": "2026-09-30"} for code in ("000001", "000002") for name in names]
            sh.save_batch(conn, ["000001", "000002"], {"total": records, "float": records})
            control.save_batch(conn, ["000002"], [{"code": "000002", "kind": "actual_controller",
                "holder_key": names[1], "holder_name": names[1], "holder_type": "控股机构", "via_name": "",
                "source_url": "https://example.com/control"}], {"000002"})
            before = [tuple(r) for r in conn.execute("SELECT * FROM stock_shareholders")]
            result = sh.stock_view(conn, "000001", day=day)
            for scope in ("total", "float"):
                self.assertEqual({r["type"] for r in result["own_holders"][scope]}, {"企业股东", "AMC"})
            self.assertEqual({r["type"] for r in result["rows"][0]["holders"]}, {"企业股东", "AMC"})
            self.assertEqual(sh.date_alerts(conn, day)["rows"], [
                {"code": "000001", "types": ["AMC", "企业股东"]}, {"code": "000002", "types": ["AMC", "企业股东"]}])
            self.assertEqual([tuple(r) for r in conn.execute("SELECT * FROM stock_shareholders")], before,
                             "old cached provider data and report periods are never overwritten by display refinements")


if __name__ == "__main__":
    unittest.main()
