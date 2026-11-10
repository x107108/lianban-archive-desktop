"""Trading-day market values from the dated Eastmoney quote."""
from datetime import datetime
from functools import lru_cache
import math
import time

import requests

import database as db
from registration import secucode


VALUATION_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/"}


def positive_number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value > 0 else None


@lru_cache(maxsize=256)
def fetch_valuation(code, day, bucket):
    security = secucode(code)
    try:
        response = requests.get(VALUATION_URL, params={
            "reportName": "RPT_VALUEANALYSIS_DET", "source": "WEB", "client": "WEB", "pageSize": 1,
            "columns": "SECUCODE,TRADE_DATE,CLOSE_PRICE,TOTAL_MARKET_CAP,NOTLIMITED_MARKETCAP_A",
            "filter": f"(SECUCODE=\"{security}\")(TRADE_DATE='{day}')",
        }, headers=HEADERS, timeout=(3, 6))
        response.raise_for_status()
        payload = response.json()
        rows = (payload.get("result") or {}).get("data") or []
        if payload.get("success") and rows:
            row = rows[0]
            if row["SECUCODE"] == security and row["TRADE_DATE"][:10] == day:
                return (positive_number(row["CLOSE_PRICE"]), positive_number(row["TOTAL_MARKET_CAP"]),
                        positive_number(row["NOTLIMITED_MARKETCAP_A"]), None)
    except (requests.RequestException, ValueError, TypeError, KeyError):
        pass

    if day == datetime.now(db.TZ).date().isoformat():
        try:
            response = requests.get(QUOTE_URL, params={"secid": f"{int(security.endswith('.SH'))}.{code}",
                                    "fields": "f43,f57,f59,f86,f116,f117"}, headers=HEADERS, timeout=(3, 6))
            response.raise_for_status()
            row = response.json().get("data") or {}
            if row.get("f57") == code and positive_number(row.get("f86")):
                stamp = datetime.fromtimestamp(row["f86"], db.TZ)
                price, decimals = positive_number(row.get("f43")), row.get("f59")
                if stamp.date().isoformat() == day and price and type(decimals) is int and 0 <= decimals <= 6:
                    return (price / 10**decimals, positive_number(row.get("f116")),
                            positive_number(row.get("f117")), stamp.isoformat(timespec="seconds"))
        except (requests.RequestException, ValueError, TypeError, OverflowError, OSError):
            pass
    return None, None, None, None


def stock_view(conn, code, day, *, refresh=True):
    secucode(code)
    if conn.execute("SELECT 1 FROM stocks WHERE code=?", (code,)).fetchone() is None:
        raise ValueError("未收录该股票")
    result = {"date": day, "total": None, "circulating": None, "free_float": None,
              "quote_at": None, "free_float_date": None}
    if not refresh:
        return result
    current = datetime.now(db.TZ).date().isoformat()
    bucket = int(time.monotonic() // (60 if day == current else 3600))
    _, total, circulating, quote_at = fetch_valuation(code, day, bucket)
    result.update(total=total, circulating=circulating, quote_at=quote_at)
    return result
