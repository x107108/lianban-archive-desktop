"""Subsidiary provenance, source classification and failure-preserving cache."""
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

import app
import database as db
import subsidiaries as sub


def source(rows, count=None, code="001219", day="2026-08-21"):
    header = "序号|关联公司名称|参控关系|参控比例|投资金额(元)|被参控公司净利润(元)|是否报表合并|被参股公司主营业务"
    cells = "".join("<tr>" + "".join(f"<td>{v}</td>" for v in r) + "</tr>" for r in rows)
    return (f"<title>青岛食品({code}) 公司资料</title><table id='ckg_table'><caption>最新公告日期：{day}"
            f" 参股或控股公司：<strong>{len(rows) if count is None else count}</strong> 家，</caption><thead><tr>"
            + "".join(f"<th>{v}</th>" for v in header.split("|")) + "</tr></thead><tbody>" + cells + "</tbody></table>")


class SubsidiaryTests(unittest.TestCase):
    def setUp(self):
        folder = Path("tests/test-data")
        folder.mkdir(exist_ok=True)
        self.path = folder / f"subsidiaries-{uuid4().hex}.sqlite3"
        self.now = datetime(2026, 10, 30, 10, tzinfo=db.TZ)
        with closing(db.connect(self.path)) as conn, conn:
            conn.execute("INSERT INTO stocks VALUES ('001219','青岛食品','SZ','2026-10-30')")

    def test_source_classification_keeps_controlled_and_lower_tier_without_ratio_guessing(self):
        html = source([
            [1, "<p>青食 &amp; 制造</p>", "子公司", "100.00%", "1万", "1万", "是", "<b>饼干</b>生产"],
            [2, "少数持股但控制", "子公司", "40.00%", "-", "-", "是", "--"],
            [3, "下层公司", "孙公司", "未披露", "-", "-", "是", "批发、零售"],
            [4, "联营", "联营企业", "60.00%", "-", "-", "否", "生产"],
            [5, "合营", "合营企业", "50.00%", "-", "-", "否", "销售"]])
        day, rows = sub.normalize_html(html, "001219", "2026-10-30")
        self.assertEqual(day, "2026-08-21")
        self.assertEqual([r["name"] for r in rows], ["青食 & 制造", "少数持股但控制", "下层公司"])
        self.assertEqual(rows[0]["business"], "饼干生产")
        self.assertEqual(rows[1]["business"], "")
        self.assertEqual(rows[2]["holding_ratio"], "")
        self.assertEqual(rows[2]["relation"], "孙公司")

    def test_malformed_truncated_mismatched_or_future_sources_do_not_become_empty_lists(self):
        row = [1, "公司", "子公司", "100%", "-", "-", "是", "制造"]
        for html in ["<title>访问验证</title>", source([row], code="000001"), source([row], count=2),
                     source([row], day="2026-10-31"), source([row]).replace("关联公司名称", "改变的列")]:
            with self.subTest(html=html[:50]), self.assertRaises(ValueError):
                sub.normalize_html(html, "001219", "2026-10-30")
        self.assertEqual(sub.normalize_html(source([]), "001219", "2026-10-30")[1], [])

    def test_cache_reused_and_failures_preserve_disclosure_then_retry(self):
        companies = [{"name": "子公司", "relation": "子公司", "holding_ratio": "100%", "business": "食品生产"}]
        with patch.object(sub, "fetch", return_value=("2026-08-21", companies)) as fetch:
            result = sub.stock_view(self.path, "001219", now=self.now)
            self.assertEqual(result["name"], "青岛食品")
            self.assertEqual(result["rows"], companies)
            sub.stock_view(self.path, "001219", now=self.now + timedelta(hours=23))
            self.assertEqual(fetch.call_count, 1)
        later = self.now + timedelta(days=1)
        with patch.object(sub, "fetch", side_effect=ValueError("来源异常")) as fetch:
            failed = sub.stock_view(self.path, "001219", now=later)
            self.assertEqual(failed["status"], "error")
            self.assertEqual(failed["rows"], companies)
            self.assertEqual(failed["fetched_at"], result["fetched_at"])
            sub.stock_view(self.path, "001219", now=later + timedelta(minutes=14))
            self.assertEqual(fetch.call_count, 1)
            sub.stock_view(self.path, "001219", now=later + timedelta(minutes=15))
            self.assertEqual(fetch.call_count, 2)
        with patch.object(sub, "fetch", return_value=("2026-06-01", [])):
            rollback = sub.stock_view(self.path, "001219", now=later + timedelta(minutes=30))
            self.assertEqual(rollback["rows"], companies)
            self.assertEqual(rollback["disclosure_date"], "2026-08-21")
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM stock_tag_overrides").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM stock_default_tags").fetchone()[0], 0)

    def test_readonly_api_and_invalid_codes_never_fetch(self):
        with patch.object(sub, "fetch") as fetch:
            result = app.read_api(SimpleNamespace(db_path=self.path, read_only=True), "/api/stock-subsidiaries?code=001219")
            self.assertEqual(result["status"], "empty")
            self.assertEqual(result["rows"], [])
            for code in ["../001219", "000001"]:
                with self.assertRaises(ValueError):
                    sub.stock_view(self.path, code)
            fetch.assert_not_called()
        with patch.object(sub, "fetch", side_effect=ValueError("来源异常")):
            failed = sub.stock_view(self.path, "001219", now=self.now)
            self.assertEqual(failed["status"], "error")
            self.assertIsNone(failed["fetched_at"])


if __name__ == "__main__":
    unittest.main()
