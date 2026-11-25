"""Dated intraday comparison reads and active-candidate collection."""
from contextlib import closing
from decimal import Decimal, ROUND_HALF_UP
import json
from pathlib import Path
import re
import sqlite3

import database as db
import intraday
import live_pool


def view(archive_path, day, *, include_live=False, code=None):
    intraday.validate_day(day)
    with closing(db.connect(archive_path)) as conn:
        dates = intraday.trading_dates(conn, include_live=include_live)
        if day not in dates:
            raise ValueError("请选择项目已知的交易日")
        previous_day = max((date for date in dates if date < day), default=None)
        previous_pool = conn.execute("SELECT 1 FROM days WHERE date=? AND status='ok'", (previous_day,)).fetchone()
        previous = {row["code"]: row["boards"] for row in conn.execute("SELECT code,boards FROM events WHERE date=?", (previous_day,))}
        previous_snapshot = live_pool.snapshot(conn, previous_day) if include_live and previous_day else None
        if previous_snapshot:
            previous = {row["code"]: row["boards"] for row in previous_snapshot["records"]}
        identity_known = bool(previous_pool or previous_snapshot)
        current_pool = conn.execute("SELECT 1 FROM days WHERE date=? AND status='ok'", (day,)).fetchone()
        current_boards = {row["code"]: row["boards"] for row in conn.execute("SELECT code,boards FROM events WHERE date=?", (day,))}
        members = {row["code"]: dict(row) for row in conn.execute("SELECT code,name,market FROM stocks" + (" WHERE code=?" if code else ""), (code,) if code else ())}
        members.update({row["code"]: row for row in intraday.catalog(archive_path) if not code or row["code"] == code})
        # Prefer a name known on or before the selected date, including former ST names.
        if code:
            names = conn.execute("SELECT code,name,market FROM events WHERE date<=? AND code=? ORDER BY date DESC LIMIT 1", (day, code))
        else:
            names = conn.execute("SELECT code,name,market FROM (SELECT code,name,market,ROW_NUMBER() OVER(PARTITION BY code ORDER BY date DESC) AS n FROM events WHERE date<=?) WHERE n=1", (day,))
        for row in names:
            members[row["code"]] = dict(row)
        snapshot = live_pool.snapshot(conn, day) if include_live else None
        if snapshot:
            members.update({row["code"]: dict(row) for row in snapshot["records"]})
            current_boards = {row["code"]: row["boards"] for row in snapshot["records"]}
        pool_known = bool(current_pool or snapshot)
    sessions, _ = intraday._cached(archive_path, day=day, code=code, detail=True)
    auctions = {}
    path = intraday.store_path(archive_path)
    if path.is_file():
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as conn:
            params = (day, code) if code else (day,)
            for context_code, stock_json in conn.execute("SELECT code,stock_json FROM session_context WHERE date=?" + (" AND code=?" if code else ""), params):
                members[context_code] = json.loads(stock_json)
            for auction_code, points_json in conn.execute("SELECT code,points_json FROM auctions WHERE date=?" + (" AND code=?" if code else ""), params):
                auctions[auction_code] = next((point for point in json.loads(points_json) if point["time"] == "09:25"), None)
    rows = []
    for stock_code, stock in sorted(members.items()):
        if (code and stock_code != code) or not re.fullmatch(r"(?:00|60|30)\d{4}", stock_code):
            continue
        session = sessions.get((day, stock_code))
        name = stock["name"]
        row = {"code": stock_code, "name": name, "initials": db.stock_initials(name),
               "boards": current_boards.get(stock_code, 0) if pool_known else None,
               "yesterday": previous.get(stock_code, 0) if identity_known else None,
               "is_st": db.is_st_name(name), "is_gem": stock_code.startswith("30"),
               "status": session["status"] if session else "missing", "points": []}
        if session and session["previous_close"] > 0:
            row.update(previous_close=session["previous_close"], source=session["source"], fetched_at=session["fetched_at"])
            previous_close = Decimal(str(session["previous_close"]))
            # Main-board ST shares use the ordinary 10% band from 2026-07-06.
            rate = Decimal(".20" if row["is_gem"] else ".05" if row["is_st"] and day < "2026-07-06" else ".10")
            tick = Decimal(".01")
            row["limit_up_price"] = float(max(previous_close + tick, (previous_close * (1 + rate)).quantize(tick, rounding=ROUND_HALF_UP)))
            row["limit_down_price"] = float(max(tick, min(previous_close - tick, (previous_close * (1 - rate)).quantize(tick, rounding=ROUND_HALF_UP))))
            auction = auctions.get(stock_code)
            for point in json.loads(session["points_json"]):
                volume = point["volume"]
                if point["time"] == "09:30" and auction and volume >= auction["volume"] and point["amount"] + .1 >= auction["amount"]:
                    volume -= auction["volume"]
                row["points"].append([point["time"], point["price"], volume / 100])
        rows.append(row)
    chart_rows = [row for row in rows if row["points"]]
    if chart_rows:
        profiles = [{"code": row["code"]} for row in chart_rows]
        with closing(db.connect(archive_path)) as conn:
            db.enrich_industries(conn, profiles)
            blacklisted = {row[0] for row in conn.execute("SELECT code FROM stock_blacklist")} if include_live else set()
        for row, profile in zip(chart_rows, profiles):
            row.update(tags=profile["tags"], registered_province=profile.get("registered_province"))
            if include_live:
                row.update(blacklisted=row["code"] in blacklisted, note=profile["note"])
    return {"date": day, "previous_date": previous_day, "identity_known": identity_known, "pool_known": pool_known,
            "rows": rows, "cached": len(chart_rows),
            "provisional": bool(snapshot), "scope": "沪深主板及创业板已知目录；仅比较所选日期已缓存且选区完整的分钟行情"}


def collect(archive_path, day, code):
    """Fill one dated comparison candidate; the UI runs a bounded active-scope queue."""
    import requests
    import intraday_sources as sources
    import threading

    if not isinstance(code, str) or not re.fullmatch(r"(?:00|60|30)\d{4}", code):
        raise ValueError("请输入沪深主板或创业板六位股票代码")
    key = (str(Path(archive_path).resolve()), code)
    with sources._lock:
        stock_lock = sources._stock_locks.setdefault(key, threading.Lock())
    with stock_lock, sources._workers:
        detail = view(archive_path, day, include_live=True, code=code)
        if not detail["rows"]:
            raise ValueError("该股票不在已知股票目录中")
        stock = detail["rows"][0]
        if stock["status"] == "ok":
            return detail
        symbol = ("sh" if code.startswith("6") else "sz") + code
        try:
            payload, raw_path = sources.fetch_json(intraday.TENCENT_URL, {"code": symbol},
                Path(archive_path).resolve().parent / "intraday_raw", f"comparison_{day}_{code}")
            event = {"date": day, "code": code, "name": stock["name"], "boards": stock["boards"] or 0,
                     "market": db.market_for(code)}
            points = intraday.normalize_tencent(payload, event)
            event["previous_close"], event["reference_basis"] = sources.tencent_reference(payload, symbol, day)
            with closing(intraday.connect(intraday.store_path(archive_path))) as conn:
                intraday.save_session(conn, event, points, "腾讯财经分时", raw_path)
        except (ValueError, KeyError, TypeError, requests.RequestException) as exc:
            with closing(intraday.connect(intraday.store_path(archive_path))) as conn:
                intraday.save_error(conn, day, code, f"分时对比获取失败：{type(exc).__name__}: {str(exc)[:160]}")
            raise ValueError(f"{stock['name']}未取得所选日完整分时，请稍后刷新重试") from exc
        return view(archive_path, day, include_live=True, code=code)
