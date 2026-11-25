from contextlib import closing
import io
import socket
import struct
import time
import unittest
from unittest.mock import patch
import zipfile
import zlib

import database as db
import market_values as mv


class MarketValueTests(unittest.TestCase):
    def tearDown(self):
        mv.free_float_snapshot.cache_clear()

    def test_report_reader_handles_fragmented_compressed_data_and_validates_rows(self):
        rows = ["0|002578|0|0|20261124|0|0|0|0|0|0|50421.20",
                "1|600876|0|0|20261124|0|0|0|0|0|0|15227.47",
                "2|920001|0|0|20261124|0|0|0|0|0|0|100.25",
                "0|000001|0|0|invalid|0|0|0|0|0|0|100",
                "0|000002|0|0|20261124|0|0|0|0|0|0|nan",
                "0|000003|0|0|20261124|0|0|0|0|0|0|-1"]
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as package:
            package.writestr("tdxstat.cfg", "\r\n".join(rows).encode("gb18030"))
        data = archive.getvalue()
        responses = bytearray()
        for chunk in (data[:100], data[100:], b""):
            body = struct.pack("<I", len(chunk)) + chunk
            packed = zlib.compress(body)
            responses.extend(struct.pack("<IIIHH", 0, 0, 0, len(packed), len(body)) + packed)

        def receive(size):
            chunk = bytes(responses[:min(size, 7)])
            del responses[:len(chunk)]
            return chunk

        with patch.object(mv.socket, "create_connection") as connect:
            stream = connect.return_value.__enter__.return_value
            stream.recv.side_effect = receive
            parsed = mv._read_tdx_stats("calc.tdx.com.cn", time.monotonic() + 6)
            self.assertEqual(parsed, {(0, "002578"): ("2026-11-24", 50421.2),
                                      (1, "600876"): ("2026-11-24", 15227.47),
                                      (2, "920001"): ("2026-11-24", 100.25)})
            self.assertEqual([struct.unpack_from("<I", call.args[0], 12)[0]
                              for call in stream.sendall.call_args_list], [0, 100, len(data)])

    def test_snapshot_falls_back_and_reuses_one_download_for_all_stocks(self):
        expected = {(0, "002578"): ("2026-11-24", 50421.2)}
        with patch.object(mv, "_read_tdx_stats", side_effect=[socket.timeout(), expected]) as read:
            self.assertEqual(mv.free_float_snapshot(-11), expected)
            self.assertEqual(mv.free_float_snapshot(-11), expected)
            self.assertEqual([c.args[0] for c in read.call_args_list],
                             ["calc.tdx.com.cn", "calc2.tdx.com.cn"])

    def test_unavailable_statistics_keep_other_market_values(self):
        with closing(db.connect(":memory:")) as conn:
            db.save_day(conn, "2026-11-24", [{"code": "002578", "name": "样本", "boards": 1}], "fixture")
            with patch.object(mv, "_read_tdx_stats", side_effect=OSError("offline")), \
                    patch.object(mv, "fetch_valuation", return_value=(5, 4000000000, 3000000000, None)):
                values = mv.stock_view(conn, "002578", "2026-11-24")
                self.assertEqual((values["total"], values["circulating"]), (4000000000, 3000000000))
                self.assertIsNone(values["free_float"])

    def test_future_or_excessive_free_float_is_not_shown(self):
        with closing(db.connect(":memory:")) as conn:
            db.save_day(conn, "2026-11-24", [{"code": "002578", "name": "样本", "boards": 1}], "fixture")
            with patch.object(mv, "fetch_valuation", return_value=(5, 4000000000, 3000000000, None)), \
                    patch.object(mv, "free_float_snapshot") as snapshot:
                for row in (("2026-11-25", 100), ("2026-11-24", 90000)):
                    snapshot.return_value = {(0, "002578"): row}
                    self.assertIsNone(mv.stock_view(conn, "002578", "2026-11-24")["free_float"])

    def test_free_float_uses_dated_vendor_shares_and_selected_day_price(self):
        with closing(db.connect(":memory:")) as conn:
            for day in ("2026-11-06", "2026-11-09"):
                db.save_day(conn, day, [{"code": "002578", "name": "样本", "boards": 1}], "fixture")
            row = ("2026-11-06", 50421.2)
            with patch.object(mv, "fetch_valuation", return_value=(5.51, 5171852308.33, 4745005711.11, None)) as fetch, \
                    patch.object(mv, "free_float_snapshot", return_value={(0, "002578"): row}):
                result = mv.stock_view(conn, "002578", "2026-11-09")
                self.assertEqual(fetch.call_args.args[:2], ("002578", "2026-11-09"))
                self.assertEqual(result["free_float"], 2778208120)
                self.assertEqual(result["free_float_date"], "2026-11-06")
                self.assertIsNone(mv.stock_view(conn, "002578", "2026-11-05")["free_float"])
                row = ("2026-11-05", 50421.2)
                mv.free_float_snapshot.return_value = {(0, "002578"): row}
                result = mv.stock_view(conn, "002578", "2026-11-09")
                self.assertEqual(result["circulating"], 4745005711.11)
                self.assertIsNone(result["free_float"])
                fetch.reset_mock()
                self.assertIsNone(mv.stock_view(conn, "002578", "2026-11-09", refresh=False)["total"])
                fetch.assert_not_called()

    def test_valuation_does_not_accept_a_different_trade_date(self):
        with patch.object(mv.requests, "get") as get:
            get.return_value.json.return_value = {"success": True, "result": {"data": [{
                "SECUCODE": "002578.SZ", "TRADE_DATE": "2026-11-09", "CLOSE_PRICE": 5.51,
                "TOTAL_MARKET_CAP": 5171852308.33, "NOTLIMITED_MARKETCAP_A": 4745005711.11,
            }]}}
            self.assertEqual(mv.fetch_valuation("002578", "2026-11-06", -1), (None, None, None, None))
            self.assertIn("2026-11-06", get.call_args.kwargs["params"]["filter"])
        mv.fetch_valuation.cache_clear()
