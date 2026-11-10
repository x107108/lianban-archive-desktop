"""Local, auditable minute archive. Browsing never makes upstream requests."""
from __future__ import annotations

from contextlib import closing
from datetime import date, datetime
import json
import math
from pathlib import Path
import re
import sqlite3

import database as db
import live_pool

EASTMONEY_URL = "https://push2his.eastmoney.com/api/qt/stock/trends2/get"
TENCENT_URL = "https://web.ifzq.gtimg.cn/appstock/app/day/query"
SCOPE = "当前沪深 A 股主板目录（已剔除 ST、*ST，不含创业板、科创板、北交所及 B 股）；按所选日期查看，未缓存个股选中后按需采集。"


def store_path(archive_path):
    return Path(archive_path).resolve().parent / "intraday.sqlite3"


def connect(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            date TEXT NOT NULL, code TEXT NOT NULL, source TEXT NOT NULL,
            status TEXT NOT NULL, note TEXT NOT NULL, fetched_at TEXT NOT NULL,
            raw_path TEXT NOT NULL, previous_close REAL NOT NULL,
            points_json TEXT NOT NULL, PRIMARY KEY(date,code)
        );
        CREATE TABLE IF NOT EXISTS attempts (
            date TEXT NOT NULL, code TEXT NOT NULL, checked_at TEXT NOT NULL,
            error TEXT NOT NULL, PRIMARY KEY(date,code)
        );
        CREATE TABLE IF NOT EXISTS universe (
            code TEXT PRIMARY KEY, name TEXT NOT NULL, market TEXT NOT NULL,
            source TEXT NOT NULL, fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS universe_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS session_context (
            date TEXT NOT NULL, code TEXT NOT NULL, stock_json TEXT NOT NULL,
            reference_basis TEXT NOT NULL, PRIMARY KEY(date,code)
        );
        CREATE TABLE IF NOT EXISTS auctions (
            date TEXT NOT NULL, code TEXT NOT NULL, status TEXT NOT NULL,
            points_json TEXT NOT NULL, note TEXT NOT NULL, source TEXT NOT NULL,
            fetched_at TEXT NOT NULL, raw_path TEXT NOT NULL, PRIMARY KEY(date,code)
        );
        CREATE TABLE IF NOT EXISTS seal_times (
            date TEXT PRIMARY KEY, stocks_json TEXT NOT NULL, source TEXT NOT NULL,
            fetched_at TEXT NOT NULL, raw_path TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS broken_pools (
            date TEXT PRIMARY KEY, stocks_json TEXT NOT NULL, source TEXT NOT NULL,
            fetched_at TEXT NOT NULL, raw_path TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS seven_minutes (
            date TEXT NOT NULL, code TEXT NOT NULL, previous_close REAL NOT NULL,
            points_json TEXT NOT NULL, interval INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(date,code)
        );
        CREATE TABLE IF NOT EXISTS seven_halts (
            date TEXT NOT NULL, code TEXT NOT NULL, PRIMARY KEY(date,code)
        );
    """)
    return conn


def validate_day(day):
    if not isinstance(day, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) or date.fromisoformat(day).isoformat() != day:
        raise ValueError("日期格式应为 YYYY-MM-DD")
    return day


def session_slot(value):
    """Compress lunch while retaining actual timestamps; no synthetic bars."""
    if not re.fullmatch(r"\d{2}:\d{2}", value):
        raise ValueError("分钟时间格式错误")
    hour, minute = map(int, value.split(":"))
    if hour > 23 or minute > 59:
        raise ValueError("分钟时间无效")
    total = hour * 60 + minute
    if 570 <= total <= 690:
        return total - 570
    if 780 <= total <= 900:
        return total - 660
    return None


def number(value, *, positive=False):
    if isinstance(value, bool):
        raise ValueError("行情数值无效")
    result = float(value)
    if not math.isfinite(result) or result < 0 or (positive and result <= 0):
        raise ValueError("行情数值必须有限且非负，价格必须大于零")
    return result


def previous_close(event):
    if event.get("previous_close") is not None:
        return number(event["previous_close"], positive=True)
    close = number(event["close"], positive=True)
    change = float(event["pct_change"])
    if not math.isfinite(change) or change <= -100:
        raise ValueError("涨停池缺少有效昨收计算字段")
    # Eastmoney's top-level preClose belongs to its latest session, not every
    # historical day. Derive each day's reference from that day's closing pool.
    return round(close / (1 + change / 100), 2)


def validate_points(points, event):
    if not points:
        raise ValueError("来源未返回该交易日的分时数据")
    times, slots = set(), set()
    for point in points:
        slot = session_slot(point["time"])
        if slot is None or point["time"] in times:
            raise ValueError("存在重复或非交易时段的分钟数据")
        if times and point["time"] <= max(times):
            raise ValueError("分钟数据未按时间递增")
        times.add(point["time"])
        slots.add(slot)
        point["price"] = number(point["price"], positive=True)
        point["volume"] = number(point["volume"])
        point["amount"] = number(point["amount"])
        if point.get("average") is not None:
            point["average"] = number(point["average"], positive=True)
        point["slot"] = slot
    close = number(event["close"], positive=True) if event.get("close") else None
    if close and points[-1]["time"] == "15:00" and abs(points[-1]["price"] - close) > max(0.02, close * 0.0005):
        raise ValueError("分时收盘价与当日涨停池收盘价不一致")
    missing = len(set(range(241)) - slots)
    status = "ok" if not missing else "partial"
    note = "241 个交易分钟已覆盖" if not missing else f"缺少 {missing} 个交易分钟，按实际返回展示，未补造数据"
    return status, note


def normalize_eastmoney(payload, event):
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or payload.get("rc") != 0 or not isinstance(data, dict) or data.get("code") != event["code"]:
        raise ValueError("东方财富返回状态或股票代码不一致")
    points = []
    for raw in data.get("trends", []):
        cells = raw.split(",")
        if len(cells) != 8:
            raise ValueError("东方财富分时字段数量异常")
        stamp = datetime.strptime(cells[0], "%Y-%m-%d %H:%M")
        if stamp.date().isoformat() != event["date"]:
            continue
        clock = stamp.strftime("%H:%M")
        if session_slot(clock) is None:
            continue
        points.append({"time": clock, "price": cells[2], "volume": number(cells[5]) * 100,
                       "amount": cells[6], "average": cells[7] if float(cells[7]) > 0 else None})
    return points


def normalize_tencent(payload, event):
    prefix = "sh" if event["code"].startswith("6") else "bj" if event["code"].startswith(("4", "8", "92")) else "sz"
    symbol = prefix + event["code"]
    if not isinstance(payload, dict) or payload.get("code") != 0 or symbol not in payload.get("data", {}):
        raise ValueError("腾讯返回状态或股票代码不一致")
    days = payload["data"][symbol].get("data", [])
    day = next((item for item in days if item.get("date") == event["date"].replace("-", "")), None)
    if day is None:
        available = sorted({item["date"] for item in days if isinstance(item, dict) and re.fullmatch(r"\d{8}", str(item.get("date", "")))})
        coverage = f"；本次返回 {available[0][:4]}-{available[0][4:6]}-{available[0][6:]} 至 {available[-1][:4]}-{available[-1][4:6]}-{available[-1][6:]}" if available else ""
        raise ValueError(f"免费分时来源未提供 {event['date']} 的分钟数据{coverage}")
    points, last_volume, last_amount = [], 0, 0
    for raw in day.get("data", []):
        cells = raw.split()
        if len(cells) != 4 or not re.fullmatch(r"\d{4}", cells[0]):
            raise ValueError("腾讯分时字段异常")
        clock = cells[0][:2] + ":" + cells[0][2:]
        if session_slot(clock) is None:
            continue
        volume, amount = number(cells[2]) * 100, number(cells[3])
        if volume < last_volume or amount < last_amount:
            raise ValueError("腾讯累计成交量额出现倒退")
        points.append({"time": clock, "price": cells[1], "volume": volume - last_volume,
                       "amount": amount - last_amount, "average": amount / volume if volume else None})
        last_volume, last_amount = volume, amount
    return points


def save_session(conn, event, points, source, raw_path):
    status, note = validate_points(points, event)
    prior = conn.execute("SELECT status,points_json FROM sessions WHERE date=? AND code=?", (event["date"], event["code"])).fetchone()
    if prior and prior["status"] == "ok" and status != "ok":
        return False
    if prior and not {p["time"] for p in json.loads(prior["points_json"])}.issubset({p["time"] for p in points}):
        return False
    with conn:
        conn.execute("""INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(date,code) DO UPDATE SET
            source=excluded.source,status=excluded.status,note=excluded.note,fetched_at=excluded.fetched_at,
            raw_path=excluded.raw_path,previous_close=excluded.previous_close,points_json=excluded.points_json""",
            (event["date"], event["code"], source, status, note, db.now_iso(), str(raw_path),
             previous_close(event), json.dumps(points, ensure_ascii=False, allow_nan=False)))
        conn.execute("DELETE FROM attempts WHERE date=? AND code=?", (event["date"], event["code"]))
        conn.execute("INSERT INTO session_context VALUES (?,?,?,?) ON CONFLICT(date,code) DO UPDATE SET stock_json=excluded.stock_json,reference_basis=excluded.reference_basis",
                     (event["date"], event["code"], json.dumps(event, ensure_ascii=False, allow_nan=False), event.get("reference_basis", "当日收盘价和涨幅推算")))
    return True


def save_error(conn, day, code, message):
    with conn:
        conn.execute("INSERT INTO attempts VALUES (?,?,?,?) ON CONFLICT(date,code) DO UPDATE SET checked_at=excluded.checked_at,error=excluded.error",
                     (day, code, db.now_iso(), str(message)))


def _cached(archive_path, *, day=None, code=None, detail=False):
    path = store_path(archive_path)
    if not path.is_file():
        return {}, {}
    # Read-only: visitors never create a cache, start collection or alter data.
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)) as conn:
        conn.row_factory = sqlite3.Row
        where, params = [], []
        for field, value in (("date", day), ("code", code)):
            if value is not None:
                where.append(f"{field}=?")
                params.append(value)
        clause = " WHERE " + " AND ".join(where) if where else ""
        fields = "*" if detail else "date,code,status,source,json_array_length(points_json) AS point_count"
        sessions = {(r["date"], r["code"]): dict(r) for r in conn.execute(f"SELECT {fields} FROM sessions" + clause, params)}
        errors = {(r["date"], r["code"]): r["error"] for r in conn.execute("SELECT * FROM attempts" + clause, params)}
    return sessions, errors


def is_mainboard(code):
    return bool(re.fullmatch(r"(?:00|60)\d{4}", str(code)))


def catalog(archive_path):
    path = store_path(archive_path)
    if not path.is_file():
        return []
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)) as conn:
        conn.row_factory = sqlite3.Row
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='universe'").fetchone():
            return []
        return [dict(row) for row in conn.execute("SELECT * FROM universe ORDER BY code")]


def auction_view(archive_path, day, code):
    missing = {"status": "unchecked", "points": [], "note": "尚未核查开盘竞价数据"}
    path = store_path(archive_path)
    if not path.is_file():
        return missing
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)) as conn:
        conn.row_factory = sqlite3.Row
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='auctions'").fetchone():
            return missing
        row = conn.execute("SELECT * FROM auctions WHERE date=? AND code=?", (day, code)).fetchone()
        if row is None:
            return missing
        result = dict(row)
        result["points"] = json.loads(result.pop("points_json"))
        result.pop("raw_path", None)
        return result


def trading_dates(conn, *, include_live=False):
    """Reuse the project's verified calendar without fetching any minute data."""
    known = set(db.get_settings(conn).get("calendar_dates") or [])
    known.update(row[0] for row in conn.execute("SELECT date FROM days WHERE status='ok'"))
    if include_live:
        known.update(live_pool.metadata(conn)["dates"])
    today = datetime.now(db.TZ).date().isoformat()
    return sorted((day for day in known if isinstance(day, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) and day <= today), reverse=True)


def broken_pool_view(archive_path, day):
    result = {"rows": [], "source": None, "fetched_at": None, "needs_collection": bool(day)}
    path = store_path(archive_path)
    if not day or not path.is_file():
        return result
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='broken_pools'").fetchone():
            return result
        row = conn.execute("SELECT * FROM broken_pools WHERE date=?", (day,)).fetchone()
    if row:
        result.update(rows=json.loads(row["stocks_json"]), source=row["source"], fetched_at=row["fetched_at"],
                      needs_collection=live_pool.minute_refresh_due(day, row["fetched_at"]))
    return result


def overview(archive_path, day=None, *, include_live=False):
    if day:
        validate_day(day)
    universe = catalog(archive_path)
    with closing(db.connect(archive_path)) as conn:
        dates = trading_dates(conn, include_live=include_live)
        if day and day not in dates:
            raise ValueError("该日期不在项目已知交易日历中，请选择交易日")
        selected = day or (dates[0] if dates else None)
        events = {r["code"]: dict(r) for r in conn.execute("SELECT date,code,name,boards,close,pct_change,first_time,last_time,market,industry FROM events WHERE date=?", (selected,))}
        snapshot = live_pool.snapshot(conn, selected) if include_live else None
        if snapshot:
            events = {r["code"]: dict(r) for r in snapshot["records"]}
        if universe and selected:
            rows = [{"date": selected, "boards": 0, "industry": None, **{k: r[k] for k in ("code", "name", "market")}, **events.get(r["code"], {})} for r in universe if not db.is_st_name(r["name"])]
        else:
            rows = [r for r in events.values() if is_mainboard(r["code"])]
        rows = [r for r in rows if not db.is_st_name(r["name"])]
        for start in range(0, len(rows), 250):
            db.enrich_industries(conn, rows[start:start + 250])
        pool = conn.execute("SELECT status,source FROM days WHERE date=?", (selected,)).fetchone()
    sessions, errors = _cached(archive_path, day=selected) if selected else ({}, {})
    broken = broken_pool_view(archive_path, selected)
    broken_stocks = {row["code"]: row for row in broken["rows"]}
    for row in rows:
        if not row["boards"] and row["code"] in broken_stocks:
            row.update(broken_stocks[row["code"]])
        row["stock_type"] = "limit_up" if row["boards"] else "broken" if row["code"] in broken_stocks else "mainboard"
        cached = sessions.get((selected, row["code"]))
        row["initials"] = db.stock_initials(row["name"])
        row.update(status=cached["status"] if cached else "missing", point_count=cached["point_count"] if cached else 0,
                   source=cached["source"] if cached else None, error=errors.get((selected, row["code"]), ""))
    return {"date": selected, "dates": dates, "rows": rows, "total": len(rows),
            "ready": sum(r["status"] == "ok" for r in rows), "partial": sum(r["status"] == "partial" for r in rows),
            "missing": sum(r["status"] == "missing" for r in rows), "scope_note": SCOPE if universe else "主板目录尚未同步，当前仅展示本地已收录的非 ST 主板个股。",
            "provisional": bool(snapshot),
            "broken_pool": {key: value for key, value in broken.items() if key != "rows"},
            "catalog_complete": bool(universe), "catalog_fetched_at": universe[0]["fetched_at"] if universe else None,
            "pool_status": "provisional" if snapshot else pool["status"] if pool else "missing", "pool_source": snapshot["source"] if snapshot else pool["source"] if pool else None}


def stock_view(archive_path, day, code, *, include_live=False):
    validate_day(day)
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请输入六位股票代码")
    member = next((r for r in catalog(archive_path) if r["code"] == code), None)
    if member and db.is_st_name(member["name"]):
        raise ValueError("分时数据已剔除 ST、*ST 股票")
    with closing(db.connect(archive_path)) as conn:
        if day not in trading_dates(conn, include_live=include_live):
            raise ValueError("该日期不在项目已知交易日历中，请选择交易日")
        row = conn.execute("SELECT date,code,name,boards,close,pct_change,first_time,last_time,industry FROM events WHERE date=? AND code=?", (day, code)).fetchone()
        snapshot = live_pool.snapshot(conn, day) if include_live else None
        if snapshot:
            row = next((dict(r) for r in snapshot["records"] if r["code"] == code), None)
        if row is None:
            if member:
                row = {"date": day, "boards": 0, "industry": None, **{k: member[k] for k in ("code", "name", "market")}}
        if row is not None:
            row = dict(row)
            if db.is_st_name(row["name"]):
                raise ValueError("分时数据已剔除 ST、*ST 股票")
            db.enrich_industries(conn, [row])
            row["initials"] = db.stock_initials(row["name"])
            row["blacklisted"] = conn.execute("SELECT 1 FROM stock_blacklist WHERE code=?", (code,)).fetchone() is not None
    if row is None:
        raise ValueError("该股票不在沪深主板目录或本地分时档案中")
    broken = next((stock for stock in broken_pool_view(archive_path, day)["rows"] if stock["code"] == code), None)
    if not row["boards"] and broken:
        row.update(broken)
    row["stock_type"] = "limit_up" if row["boards"] else "broken" if broken else "mainboard"
    sessions, errors = _cached(archive_path, day=day, code=code, detail=True)
    cached = sessions.get((day, code))
    result = {"date": day, "stock": dict(row), "status": "missing", "points": [], "note": errors.get((day, code), "该股票当日分时尚未采集")}
    if cached:
        result.update(status=cached["status"], points=json.loads(cached["points_json"]), note=cached["note"],
                      previous_close=cached["previous_close"], source=cached["source"], fetched_at=cached["fetched_at"])
    result["reference_basis"] = "当日收盘价和涨幅推算"
    if cached:
        path = store_path(archive_path)
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as conn:
            attempt = conn.execute("SELECT checked_at FROM attempts WHERE date=? AND code=?", (day, code)).fetchone()
            result["refresh_checked_at"] = max(result["fetched_at"], attempt[0]) if attempt else result["fetched_at"]
            if conn.execute("SELECT 1 FROM sqlite_master WHERE name='session_context'").fetchone():
                context = conn.execute("SELECT reference_basis FROM session_context WHERE date=? AND code=?", (day, code)).fetchone()
                if context:
                    result["reference_basis"] = context[0]
    result["auction"] = auction_view(archive_path, day, code)
    result["needs_collection"] = not result["points"] or result["auction"]["status"] == "unchecked"
    result["refresh_error"] = errors.get((day, code))
    result["needs_refresh"] = include_live and live_pool.minute_refresh_due(day, result.get("refresh_checked_at"))
    result["provisional"] = bool(snapshot)
    if include_live and day == datetime.now(db.TZ).date().isoformat() and live_pool.polling_time() and result["points"]:
        result["note"] = f"盘中分钟数据，当前已缓存 {len(result['points'])} 个交易分钟；尚未收盘。"
    return result
