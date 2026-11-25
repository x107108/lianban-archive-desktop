"""Source validation, dated membership and preservation of personal stock data."""
from contextlib import closing
from copy import deepcopy
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4
import json
import unittest

import convertible_bonds as bonds
import database as db


def payload(**changes):
    row = {"SECURITY_CODE": "113001", "SECUCODE": "113001.SH", "SECURITY_NAME_ABBR": "合成转债",
           "CONVERT_STOCK_CODE": "600001", "LISTING_DATE": "2026-11-10 00:00:00",
           "DELIST_DATE": "2026-11-24 00:00:00", "EXPIRE_DATE": "2030-01-01 00:00:00"}
    row.update(changes)
    return {"success": True, "result": {"count": 1, "pages": 1, "data": [row]}}


class ConvertibleBondTests(unittest.TestCase):
    def setUp(self):
        self.path = Path(__file__).parent / "test-data" / ("bonds-" + uuid4().hex) / "archive.sqlite3"

    def seed(self, records):
        with patch.object(bonds, "fetch", return_value=(records, ["synthetic.json"])):
            bonds.refresh(self.path)

    def test_active_membership_respects_listing_delisting_and_multiple_bonds(self):
        records, _, _ = bonds.normalize(payload())
        self.seed(records)
        with closing(db.connect(self.path)) as conn:
            for day, expected in (("2026-11-09", False), ("2026-11-10", True),
                                  ("2026-11-23", True), ("2026-11-24", False)):
                row = {"code": "600001", "date": day}
                db.enrich_industries(conn, [row])
                self.assertIs(row["has_convertible_bond"], expected)
            with conn:
                conn.execute("INSERT INTO convertible_bonds VALUES (?,?,?,?,?,?)",
                             ("113002", "600001", "合成二债", "2026-11-20", None, "2030-01-01"))
            rows = [{"code": "600001"}, {"code": "600002"}]
            db.enrich_industries(conn, rows, as_of="2026-11-24")
            self.assertEqual([r["has_convertible_bond"] for r in rows], [True, False])

    def test_unlisted_and_expired_bonds_are_not_marked(self):
        unlisted, _, _ = bonds.normalize(payload(LISTING_DATE=None))
        expired, _, _ = bonds.normalize(payload(SECURITY_CODE="113002", SECUCODE="113002.SH", CONVERT_STOCK_CODE="600002",
                                               DELIST_DATE=None, EXPIRE_DATE="2026-11-23 00:00:00"))
        self.seed(unlisted + expired)
        with closing(db.connect(self.path)) as conn:
            rows = [{"code": code} for code in ("600001", "600002")]
            db.enrich_industries(conn, rows, as_of="2026-11-23")
            self.assertEqual([r["has_convertible_bond"] for r in rows], [False, False])

    def test_dated_archive_and_provisional_pool_share_query_date_and_preserve_user_data(self):
        self.seed(bonds.normalize(payload())[0])
        with closing(db.connect(self.path)) as conn:
            for day in ("2026-11-09", "2026-11-23", "2026-11-24"):
                db.save_day(conn, day, [{"code": "600001", "name": "合成测试", "boards": 1}], "synthetic")
            db.save_stock_tags(conn, "600001", ["保留标签"], 0)
            with conn:
                conn.execute("INSERT INTO stock_blacklist VALUES (?,?)", ("600001", db.now_iso()))
            original = [tuple(r) for r in conn.execute("SELECT * FROM events ORDER BY date")]
            for day, expected in (("2026-11-09", False), ("2026-11-23", True), ("2026-11-24", False)):
                row = db.date_view(conn, day)["rows"][0]
                self.assertIs(row["has_convertible_bond"], expected)
                self.assertEqual(row["tags"], ["保留标签"])
                self.assertTrue(row["blacklisted"])
            # Live pool records need not carry their own date.
            snapshot = {"records": [{"code": "600001", "name": "合成测试", "market": "沪市主板", "boards": 1}],
                        "source": "synthetic", "note": "synthetic", "fetched_at": db.now_iso()}
            db.save_day(conn, "2026-11-25", [], "synthetic", status="failed")
            self.assertFalse(db.date_view(conn, "2026-11-25", snapshot=snapshot)["rows"][0]["has_convertible_bond"])
            self.assertEqual(original, [tuple(r) for r in conn.execute("SELECT * FROM events ORDER BY date")])

    def test_bad_schema_dates_and_identity_are_rejected(self):
        bad = [payload(CONVERT_STOCK_CODE="60001"), payload(SECUCODE="113002.SH"), payload(SECURITY_NAME_ABBR=""),
               payload(LISTING_DATE="bad"), payload(DELIST_DATE="2020-01-01 00:00:00")]
        missing = payload(); missing["success"] = False; bad.append(missing)
        missing = payload(); missing["result"]["data"] = [None]; bad.append(missing)
        for source in bad:
            with self.subTest(source=source), self.assertRaises(ValueError):
                bonds.normalize(source)

    def test_incomplete_and_duplicate_pages_do_not_replace_cache(self):
        good = payload()
        self.seed(bonds.normalize(good)[0])
        for duplicate, bad in enumerate((deepcopy(good), deepcopy(good))):
            bad["result"]["count"] = 2
            # One response is short; the other repeats a bond instead of supplying the missing one.
            if duplicate:
                bad["result"]["data"] *= 2
            raw = json.dumps(bad).encode()
            with patch.object(bonds, "urlopen", return_value=BytesIO(raw)), self.assertRaises(ValueError):
                bonds.refresh(self.path)
            with closing(db.connect(self.path)) as conn:
                self.assertEqual(conn.execute("SELECT bond_code FROM convertible_bonds").fetchall()[0][0], "113001")
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM convertible_bonds").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
