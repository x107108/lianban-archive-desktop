"""Trading-day market values and the dated Tongdaxin free-float share count."""
from datetime import datetime
from functools import lru_cache
import io
import math
import socket
import struct
import zipfile
import zlib
from threading import Lock
import time

import requests

import database as db
from registration import secucode


VALUATION_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get"
HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/"}
FREE_FLOAT_LOCK = Lock()


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


def _read_exact(stream, size, deadline):
    data = bytearray()
    while len(data) < size:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Tongdaxin statistics download timed out")
        stream.settimeout(min(3, remaining))
        part = stream.recv(size - len(data))
        if not part:
            raise OSError("Tongdaxin statistics connection closed")
        data.extend(part)
    return bytes(data)


def _read_tdx_stats(host, deadline):
    # Tongdaxin report-file protocol 0x06b9; see docs/FREE-FLOAT.md.
    archive = bytearray()
    with socket.create_connection((host, 7709), timeout=min(3, max(.001, deadline - time.monotonic()))) as stream:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Tongdaxin statistics download timed out")
            stream.settimeout(min(3, remaining))
            body = struct.pack("<HII100s", 0x06b9, len(archive), 30000, b"zhb.zip")
            stream.sendall(bytes.fromhex("0c1234000000") + struct.pack("<HH", len(body), len(body)) + body)
            packed_size, raw_size = struct.unpack_from("<HH", _read_exact(stream, 16, deadline), 12)
            payload = _read_exact(stream, packed_size, deadline)
            if packed_size != raw_size:
                payload = zlib.decompress(payload)
            if len(payload) != raw_size or raw_size < 4:
                raise ValueError("Invalid Tongdaxin statistics response")
            size = struct.unpack_from("<I", payload)[0]
            if size > 30000 or size + 4 != len(payload):
                raise ValueError("Invalid Tongdaxin statistics chunk")
            if not size:
                break
            archive.extend(payload[4:])
            if len(archive) > 10 * 1024 * 1024:
                raise ValueError("Tongdaxin statistics archive is too large")
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        member = package.getinfo("tdxstat.cfg")
        if member.file_size > 10 * 1024 * 1024:
            raise ValueError("Tongdaxin statistics file is too large")
        text = package.read(member).decode("gb18030")
    rows = {}
    for line in text.splitlines():
        fields = line.split("|")
        if len(fields) <= 11 or fields[0] not in ("0", "1", "2") or len(fields[1]) != 6 or not fields[1].isascii() or not fields[1].isdigit():
            continue
        try:
            day = datetime.strptime(fields[4], "%Y%m%d").date().isoformat()
            shares = positive_number(float(fields[11]))
        except ValueError:
            continue
        if shares:
            rows[int(fields[0]), fields[1]] = (day, shares)
    if not rows:
        raise ValueError("Tongdaxin statistics contain no valid free-float shares")
    return rows


@lru_cache(maxsize=1)
def free_float_snapshot(bucket):
    deadline = time.monotonic() + 6
    for host in ("calc.tdx.com.cn", "calc2.tdx.com.cn"):
        try:
            return _read_tdx_stats(host, deadline)
        except (OSError, ValueError, KeyError, struct.error, zlib.error, zipfile.BadZipFile):
            pass
    return {}


def stock_view(conn, code, day, *, refresh=True):
    security = secucode(code)
    if conn.execute("SELECT 1 FROM stocks WHERE code=?", (code,)).fetchone() is None:
        raise ValueError("未收录该股票")
    result = {"date": day, "total": None, "circulating": None, "free_float": None,
              "quote_at": None, "free_float_date": None}
    if not refresh:
        return result
    current = datetime.now(db.TZ).date().isoformat()
    bucket = int(time.monotonic() // (60 if day == current else 3600))
    price, total, circulating, quote_at = fetch_valuation(code, day, bucket)
    result.update(total=total, circulating=circulating, quote_at=quote_at)
    if price and circulating:
        market = {"SZ": 0, "SH": 1, "BJ": 2}[security[-2:]]
        with FREE_FLOAT_LOCK:
            row = free_float_snapshot(int(time.monotonic() // 1800)).get((market, code))
        if row:
            stats_day, shares_10k = row
            previous = conn.execute("SELECT MAX(date) FROM days WHERE date<? AND status='ok'", (day,)).fetchone()[0]
            free_float = price * shares_10k * 10000
            if (previous or day) <= stats_day <= day and free_float <= circulating * 1.0001:
                result.update(free_float=free_float, free_float_date=stats_day)
    return result
