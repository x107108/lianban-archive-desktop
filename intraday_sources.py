"""Explicit local collection for the complete main-board picker and auctions."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime
import hashlib
import json
from pathlib import Path
import threading
import re

import database as db
import intraday

AUCTION_URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_Bill.GetBillList"
BROKEN_POOL_SOURCE = "选股宝公开破板池（全市场）"
_lock = threading.Lock()
_stock_locks = {}
_workers = threading.BoundedSemaphore(4)


def fetch_json(url, params, raw_dir, label):
    import requests
    referer = "https://vip.stock.finance.sina.com.cn/" if "sina" in url else "https://quote.eastmoney.com/"
    for attempt in range(2):
        try:
            response = requests.get(url, params=params, timeout=(4, 10), headers={
                "User-Agent": "Mozilla/5.0", "Referer": referer})
            response.raise_for_status()
            break
        except requests.RequestException:
            if attempt:
                raise
    payload = response.json()
    raw_dir = Path(raw_dir)
    raw_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(response.content).hexdigest()[:12]
    path = raw_dir / f"{label}_{datetime.now(db.TZ):%Y%m%dT%H%M%S%f}_{digest}.json"
    path.write_bytes(response.content)
    return payload, str(path)


def save_catalog(archive_path, records, total, source="主板目录"):
    if len(records) != total or len({r["code"] for r in records}) != total:
        raise ValueError("主板目录分页缺失或重复，保留原目录")
    if any(not intraday.is_mainboard(r["code"]) or not r["name"].strip() for r in records):
        raise ValueError("主板目录包含非主板股票或无效名称")
    stamp = db.now_iso()
    with closing(intraday.connect(intraday.store_path(archive_path))) as conn, conn:
        conn.execute("CREATE TEMP TABLE incoming_codes (code TEXT PRIMARY KEY)")
        conn.executemany("INSERT INTO incoming_codes VALUES (?)", [(r["code"],) for r in records])
        conn.executemany("INSERT INTO universe VALUES (?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,market=excluded.market,source=excluded.source,fetched_at=excluded.fetched_at",
                         [(r["code"], r["name"], db.market_for(r["code"]), source, stamp) for r in records])
        # This removes stale database rows only, never files or historical sessions.
        conn.execute("DELETE FROM universe WHERE code NOT IN (SELECT code FROM incoming_codes)")
        conn.execute("INSERT OR REPLACE INTO universe_meta VALUES ('snapshot',?)", (json.dumps({"total": total, "fetched_at": stamp}),))
    with closing(db.connect(archive_path)) as conn, conn:
        conn.executemany("INSERT OR IGNORE INTO stocks VALUES (?,?,?,?)", [(r["code"], r["name"], db.market_for(r["code"]), stamp[:10]) for r in records])
    return {"total": total, "fetched_at": stamp}


def sync_catalog(archive_path):
    """Query every legal 00/60 code slot; keep only provider-identified A shares.

    A bounded quote request avoids incomplete directory pagination. Every batch
    is retained so the exact requested ranges and returned symbols are auditable.
    """
    import requests
    raw = Path(archive_path).resolve().parent / "intraday_raw"
    raw.mkdir(parents=True, exist_ok=True)
    symbols = [f"sz{n:06}" for n in range(10000)] + [f"sh{n:06}" for n in range(600000, 610000)]
    batches = [symbols[i:i + 500] for i in range(0, len(symbols), 500)]
    def batch(items):
        for attempt in range(2):
            try:
                response = requests.get("https://qt.gtimg.cn/q=" + ",".join(items), timeout=(4, 12))
                response.raise_for_status()
                response.encoding = "gbk"
                if not response.text.lstrip().startswith("v_"):
                    raise ValueError("主板行情目录响应不是证券报价")
                break
            except requests.RequestException:
                if attempt:
                    raise
        (raw / f"quote_catalog_{items[0]}_{datetime.now(db.TZ):%Y%m%dT%H%M%S}.txt").write_text(response.text, encoding="utf-8")
        result = []
        for symbol, body in re.findall(r'v_((?:sz|sh)\d{6})="([^"]*)"', response.text):
            cells = body.split("~")
            if symbol not in items or len(cells) < 31 or cells[2] != symbol[2:]:
                raise ValueError("行情目录代码与请求不一致")
            if "GP-A" in cells and not cells[1].endswith("退") and not cells[1].startswith("退市"):
                result.append({"code": cells[2], "name": cells[1]})
        return result
    with ThreadPoolExecutor(max_workers=3) as pool:
        records = [row for group in pool.map(batch, batches) for row in group]
    if not 3000 <= len(records) <= 5000:
        raise ValueError("全号段行情目录数量异常，未覆盖本地目录")
    return save_catalog(archive_path, records, len(records), "腾讯沪深主板行情目录（00/60 全号段核验）")


def collect_broken_pool(archive_path, day):
    """Fetch one selected day's failed-limit names, never every stock's minutes."""
    intraday.validate_day(day)
    with closing(db.connect(archive_path)) as conn:
        if day not in intraday.trading_dates(conn, include_live=True):
            raise ValueError("该日期不在项目已知交易日历中")
    if not intraday.broken_pool_view(archive_path, day)["needs_collection"]:
        return intraday.overview(archive_path, day, include_live=True)
    fetch_broken_pool(archive_path, day)
    return intraday.overview(archive_path, day, include_live=True)


def fetch_broken_pool(archive_path, day):
    """Validate and cache all markets; the main-board picker still filters its own scope."""
    import provider
    raw_dir = Path(archive_path).resolve().parent / "intraday_raw"
    payload, raw_path = fetch_json(provider.POOL_URL, {"pool_name": "limit_up_broken", "date": day}, raw_dir, f"broken_{day}")
    if payload.get("code") != 20000 or not isinstance(payload.get("data"), list) or not payload["data"]:
        raise ValueError("来源暂未提供该日可核验的破板名单，保留已有缓存")
    records = {}
    for item in payload["data"]:
        symbol = str(item.get("symbol", ""))
        if not re.fullmatch(r"\d{6}\.(SS|SH|SZ|BJ)", symbol):
            raise ValueError("破板来源股票代码无效")
        code, name = symbol[:6], re.sub(r"\s+", "", str(item.get("stock_chi_name") or ""))
        first = provider._time_on_day(item["first_limit_up"], "first_limit_up", day) if item.get("first_limit_up") else None
        last = provider._time_on_day(item["last_limit_up"], "last_limit_up", day) if item.get("last_limit_up") else None
        broken = provider._time_on_day(item.get("last_break_limit_up"), "last_break_limit_up", day)
        if (not name or item.get("limit_up_days") != 0 or item.get("break_limit_up_times", 0) <= 0
                or any(clock and clock > broken for clock in (first, last))):
            raise ValueError("来源未证明该股票触板后未封住，保留已有缓存")
        close = intraday.number(item.get("price"), positive=True)
        change = provider._number(item.get("change_percent"), "change_percent") * 100
        if change <= -100:
            raise ValueError("破板股票涨跌幅无效")
        if code in records:
            raise ValueError("破板名单存在重复股票")
        records[code] = {"date": day, "code": code, "name": name, "market": db.market_for(code), "boards": 0,
                         "stock_type": "broken", "close": close, "pct_change": change,
                         "first_time": first, "broken_time": broken}
    with closing(intraday.connect(intraday.store_path(archive_path))) as conn, conn:
        conn.execute("INSERT INTO broken_pools VALUES (?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET stocks_json=excluded.stocks_json,source=excluded.source,fetched_at=excluded.fetched_at,raw_path=excluded.raw_path",
                     (day, json.dumps(list(records.values()), ensure_ascii=False, allow_nan=False), BROKEN_POOL_SOURCE, db.now_iso(), raw_path))


def tencent_reference(payload, symbol, day):
    data = payload["data"][symbol]
    quote = data.get("qt", {}).get(symbol, [])
    if len(quote) > 30 and str(quote[30]).startswith(day.replace("-", "")):
        return intraday.number(quote[4], positive=True), "腾讯当日昨收字段"
    previous = sorted((r for r in data.get("data", []) if r.get("date", "") < day.replace("-", "")), key=lambda r: r["date"])
    for session in reversed(previous):
        closing = [r.split() for r in session.get("data", []) if r.split()[0] == "1500"]
        if closing:
            return intraday.number(closing[-1][1], positive=True), "前交易日分时收盘参考（未校正除权）"
    raise ValueError("来源未提供可核对的当日昨收或前交易日收盘参考")


def normalize_auction(payload, symbol, points):
    if not isinstance(payload, list):
        raise ValueError("竞价来源返回无效")
    rows = [r for r in payload if r.get("symbol") == symbol and r.get("ticktime") == "09:25:00"]
    if not rows:
        return []
    if len(rows) != 1:
        raise ValueError("竞价撮合记录重复")
    row = rows[0]
    price, volume = intraday.number(row["price"], positive=True), intraday.number(row["volume"])
    opening = next((p for p in points if p["time"] == "09:30"), None)
    if opening and (abs(price - opening["price"]) > 0.011 or volume > opening["volume"]):
        raise ValueError("竞价撮合价量与所选日期分时开盘记录不一致")
    return [{"time": "09:25", "price": price, "volume": volume, "amount": round(price * volume, 2)}]


def collect_requested(archive_path, day, code, *, force=False):
    detail = intraday.stock_view(archive_path, day, code, include_live=True)  # validates date, code and membership
    key = (str(Path(archive_path).resolve()), code)
    with _lock:
        stock_lock = _stock_locks.setdefault(key, threading.Lock())
    with stock_lock, _workers:
        detail = intraday.stock_view(archive_path, day, code, include_live=True)
        raw_dir = Path(archive_path).resolve().parent / "intraday_raw"
        symbol = ("sh" if code.startswith("6") else "sz") + code
        if not detail["points"] or detail["needs_refresh"] or (force and detail["status"] != "ok"):
            try:
                payload, raw_path = fetch_json(intraday.TENCENT_URL, {"code": symbol}, raw_dir, f"mainboard_{code}")
                event = dict(detail["stock"])
                points = intraday.normalize_tencent(payload, event)
                if not event.get("close"):
                    event["previous_close"], event["reference_basis"] = tencent_reference(payload, symbol, day)
                with closing(intraday.connect(intraday.store_path(archive_path))) as conn:
                    intraday.save_session(conn, event, points, "腾讯财经分时", raw_path)
            except Exception as exc:
                with closing(intraday.connect(intraday.store_path(archive_path))) as conn:
                    intraday.save_error(conn, day, code, f"按需采集失败：{type(exc).__name__}: {str(exc)[:160]}")
            detail = intraday.stock_view(archive_path, day, code, include_live=True)
        if detail["points"] and (force or detail["auction"]["status"] == "unchecked"):
            source, raw_path, points = "新浪财经 09:25 撮合记录", "", []
            try:
                payload, raw_path = fetch_json(AUCTION_URL, {"symbol": symbol, "num": 60, "page": 1, "sort": "ticktime", "asc": 1, "volume": 0, "amount": 0, "type": 0, "day": day}, raw_dir, f"auction_{day}_{code}")
                points = normalize_auction(payload, symbol, detail["points"])
                note = "仅含 09:25 实际撮合价量；09:15—09:24 虚拟匹配走势未取得。竞价量从 09:30 累计首柱扣除，避免重复。" if points else "来源未返回该日 09:25 撮合记录；未用 09:30 数据代替。"
            except Exception as exc:
                note = f"竞价暂不可用：{type(exc).__name__}；未用 09:30 数据代替。"
            with closing(intraday.connect(intraday.store_path(archive_path))) as conn, conn:
                previous = conn.execute("SELECT status FROM auctions WHERE date=? AND code=?", (day, code)).fetchone()
                if points or not previous or previous[0] != "match_only":
                    conn.execute("INSERT OR REPLACE INTO auctions VALUES (?,?,?,?,?,?,?,?)", (day, code, "match_only" if points else "unavailable", json.dumps(points, ensure_ascii=False, allow_nan=False), note, source, db.now_iso(), raw_path))
        return intraday.stock_view(archive_path, day, code, include_live=True)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="同步完整沪深主板目录，或采集指定个股分时及 09:25 竞价撮合记录")
    parser.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    parser.add_argument("--catalog", action="store_true")
    parser.add_argument("--date")
    parser.add_argument("--codes", nargs="+")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if args.catalog:
        print(json.dumps(sync_catalog(args.db), ensure_ascii=False), flush=True)
    if args.date and args.codes:
        for code in args.codes:
            detail = collect_requested(args.db, args.date, code, force=args.force)
            print(json.dumps({"code": code, "status": detail["status"], "points": len(detail["points"]), "auction": detail["auction"]["status"]}, ensure_ascii=False), flush=True)
