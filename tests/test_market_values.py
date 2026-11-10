from contextlib import closing
import unittest
from unittest.mock import patch

import database as db
import market_values as mv


class MarketValueTests(unittest.TestCase):
    def test_market_value_uses_dated_source_and_keeps_unverified_free_float_empty(self):
        with closing(db.connect(":memory:")) as conn:
            db.save_day(conn, "2026-11-09", [{"code":"002578", "name":"闽发铝业", "boards":1}], "synthetic")
            with patch.object(mv, "fetch_valuation", return_value=(5.51, 5000000000, 3000000000, None)) as fetch:
                values = mv.stock_view(conn, "002578", "2026-11-09")
                self.assertEqual((values["total"], values["circulating"]), (5000000000, 3000000000))
                self.assertIsNone(values["free_float"])
                self.assertEqual(fetch.call_args.args[:2], ("002578", "2026-11-09"))
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
