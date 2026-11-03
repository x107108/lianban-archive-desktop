"""Read-only, reproducible observations from the closing pool and minute cache."""
from contextlib import closing
from decimal import Decimal, ROUND_HALF_UP
import json
import math
import re
import sqlite3
from statistics import median

import database as db
import intraday
import live_pool

SEAL_KINDS = ("seal", "relock", "last_seal")


def cached_seal_times(archive_path, day):
    path = intraday.store_path(archive_path)
    if not path.exists():
        return None
    with closing(sqlite3.connect(path)) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='seal_times'").fetchone():
            return None
        row = conn.execute("SELECT stocks_json,source FROM seal_times WHERE date=?", (day,)).fetchone()
    return {"stocks": json.loads(row[0]), "source": row[1]} if row else None


def collect_seal_times(archive_path, day, *, force=False):
    """Cache independently validated source clocks without replacing closing-pool facts."""
    intraday.validate_day(day)
    with closing(db.connect(archive_path)) as conn:
        if not conn.execute("SELECT 1 FROM days WHERE date=? AND status='ok'", (day,)).fetchone():
            raise ValueError("该日尚无已确认的涨停池")
    cached = cached_seal_times(archive_path, day)
    if cached and not force:
        return {"date": day, "count": len(cached["stocks"]), "cached": True}
    import provider
    result = provider._historical_day(day, provider.RAW_DIR)
    if result.status != "ok" or not result.records:
        raise ValueError("该日来源暂未提供可核验的秒级封板时间")
    stocks = {row["code"]: {key: row.get(key) for key in ("close", "first_time", "last_time")} for row in result.records}
    with closing(intraday.connect(intraday.store_path(archive_path))) as conn, conn:
        conn.execute("INSERT INTO seal_times VALUES (?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET stocks_json=excluded.stocks_json,source=excluded.source,fetched_at=excluded.fetched_at,raw_path=excluded.raw_path",
                     (day, json.dumps(stocks), result.source, db.now_iso(), result.raw_path))
    return {"date": day, "count": len(stocks), "cached": False}


def enrich_seal_times(archive_path, day, pool):
    cached = cached_seal_times(archive_path, day)
    for stock in pool:
        supplement = cached["stocks"].get(stock["code"]) if cached else None
        if not supplement or not stock.get("close") or not supplement.get("close") or cents(stock["close"]) != cents(supplement["close"]):
            continue
        for field in ("first_time", "last_time"):
            if not stock.get(field) and clock_seconds(supplement.get(field)) is not None:
                stock[field] = supplement[field]
                stock["clock_source"] = cached["source"]
    return {"cached": cached is not None, "missing": sum(clock_seconds(stock.get("first_time")) is None for stock in pool)}


def clock_seconds(clock):
    if not isinstance(clock, str) or not re.fullmatch(r"\d{2}:\d{2}(?::\d{2})?", clock):
        return None
    parts = list(map(int, clock.split(":")))
    hour, minute, second = parts[0], parts[1], parts[2] if len(parts) > 2 else 0
    return hour * 3600 + minute * 60 + second if hour < 24 and minute < 60 and second < 60 else None


def regular_time(clock):
    second = clock_seconds(clock)
    return second is not None and (34200 <= second <= 41400 or 46800 <= second <= 54000)


def cents(value):
    return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def rapid_moves(points, previous_close):
    """Keep the first 3-point crossing of each wave in contiguous minute data."""
    if not previous_close or previous_close <= 0:
        return []
    moves, recent, wave, previous_minute = [], [], None, None
    for point in points:
        if not regular_time(point["time"]):
            continue
        minute = clock_seconds(point["time"]) // 60
        current = {"minute": minute, "time": point["time"], "price": point["price"]}
        if previous_minute is None or minute - previous_minute != 1:
            recent, wave = [], None
        previous_minute = minute
        recent = [p for p in recent if minute - p["minute"] <= 5]
        if wave:
            extreme, direction = wave["extreme"], wave["direction"]
            if (current["price"] - extreme["price"]) * direction > 0:
                wave["extreme"] = current
            elif (extreme["price"] - current["price"]) * direction / previous_close * 100 >= 1 - 1e-9 or minute - extreme["minute"] >= 5:
                # A one-point reversal or five minutes without a new extreme
                # starts a new wave; carry its turning point into the new leg.
                recent = [extreme] if minute - extreme["minute"] <= 5 else []
                wave = None
        if wave is None and recent:
            low, high = min(recent, key=lambda p: p["price"]), max(recent, key=lambda p: p["price"])
            candidates = [(low, 1), (high, -1)]
            candidates = [(start, direction) for start, direction in candidates
                          if (current["price"] - start["price"]) * direction / previous_close * 100 >= 3 - 1e-9]
            if candidates:
                start, direction = max(candidates, key=lambda item: item[0]["minute"])
                change = (current["price"] - start["price"]) / previous_close * 100
                moves.append({"kind": "rapid_up" if direction > 0 else "rapid_down", "time": current["time"],
                              "label": "快速涨幅" if direction > 0 else "快速跌幅", "price": current["price"],
                              "start_time": start["time"], "start_price": start["price"],
                              "change_pp": round(change, 4), "duration_minutes": minute - start["minute"],
                              "from_pct": round((start["price"] / previous_close - 1) * 100, 4),
                              "to_pct": round((current["price"] / previous_close - 1) * 100, 4)})
                wave = {"direction": direction, "extreme": current}
        recent.append(current)
    return moves


def stock_events(stock, points, auction=None, multiple=10, *, previous_close=None):
    """Minute observations never claim to reconstruct intra-minute order books."""
    events = []
    limit = cents(stock["close"]) if stock.get("close") and math.isfinite(float(stock["close"])) and float(stock["close"]) > 0 else None
    first = stock.get("first_time")
    first_second = clock_seconds(first)

    def add(kind, label, clock, precision, detail, **fields):
        second = clock_seconds(clock)
        if not regular_time(clock):
            return
        events.append({"id": f"{stock['code']}-{kind}-{clock}", "code": stock["code"],
                       "name": stock["name"], "boards": stock["boards"], "kind": kind,
                       "label": label, "time": clock, "minute": second // 60,
                       "precision": precision, "detail": detail, **fields})

    if first_second is not None:
        add("seal", "首次封板", first, "source", f"{stock.get('clock_source', '当日收盘涨停池')}提供的首次封板时间")
    last = stock.get("last_time")
    last_second = clock_seconds(last)
    if first_second is not None and last_second is not None and last_second > first_second:
        add("last_seal", "最终封板", last, "source", f"{stock.get('clock_source', '当日收盘涨停池')}提供的最后封板时间")

    adjusted = [dict(p) for p in points]
    match = (auction or {}).get("points", [])
    match = next((p for p in match if p.get("time") == "09:25"), None)
    if match:
        for point in adjusted:
            if point["time"] == "09:30" and point["volume"] >= match["volume"]:
                point["volume"] -= match["volume"]
    day_volume = sum(p["volume"] for p in adjusted)
    first_minute = first_second // 60 if first_second is not None and (regular_time(first) or first_second == 33900) else next(
        (clock_seconds(p["time"]) // 60 for p in adjusted if regular_time(p["time"]) and limit is not None and cents(p["price"]) == limit), None)
    seen_limit, previous, recent = False, None, []
    for point in adjusted:
        minute = clock_seconds(point["time"]) // 60
        at_limit = limit is not None and cents(point["price"]) == limit
        adjacent = previous is not None and minute - previous["minute"] == 1
        if not adjacent:
            recent = []
        if at_limit:
            if not seen_limit:
                if first_second is None:
                    add("seal", "涨停价出现", point["time"], "minute", "本地分时首次观察到涨停价，不等同于全天首次封板", price=point["price"])
                seen_limit = True
            elif adjacent and not previous["at_limit"]:
                add("relock", "回封观察", point["time"], "minute", "相邻分钟价格由低于涨停价回到涨停价", price=point["price"])
        elif adjacent and previous["at_limit"]:
            add("break", "开板观察", point["time"], "minute", "相邻分钟价格由涨停价降至涨停价以下", price=point["price"])
        if len(recent) >= 5 and 570 < minute < 897:
            baseline = median(recent[-5:])
            volume = point["volume"]
            if baseline > 0 and volume >= multiple * baseline and volume >= max(10000, day_volume * .005):
                phase = "unknown" if first_minute is None else "before" if minute < first_minute else "after" if minute > first_minute else "at"
                label = {"before": "涨停前放量", "after": "涨停后放量", "at": "涨停当分钟放量", "unknown": "放量（时点缺失）"}[phase]
                add("volume", label, point["time"], "minute", "本分钟量达到此前连续5分钟中位数的指定倍数，且不低于日内量0.5%和100手；按已知首次涨停时点区分前后，同一分钟不推断先后，开板后仍归涨停后",
                    volume=volume, baseline=baseline, ratio=round(volume / baseline, 2), price=point["price"], volume_phase=phase)
        recent.append(point["volume"])
        previous = {"minute": minute, "at_limit": at_limit}
    for move in rapid_moves(adjusted, previous_close):
        add(move["kind"], move["label"], move["time"], "minute",
            f"{move['start_time']}—{move['time']}，{move['duration_minutes']}分钟内涨跌幅由{move['from_pct']:+.2f}%变为{move['to_pct']:+.2f}%，变化{move['change_pp']:+.2f}个百分点；同一波首次达到3个百分点时记录，反向回撤1个百分点或5分钟未创新极值后重新识别",
            **{key: value for key, value in move.items() if key not in ("kind", "label", "time")})
    return events


def associate(events, window):
    events = sorted((event for event in events if regular_time(event.get("time"))),
                    key=lambda e: (e["minute"], clock_seconds(e["time"]), -e["boards"], e["code"], e["kind"]))
    for index, event in enumerate(events):
        event["related"] = []
        if event["kind"] not in SEAL_KINDS:
            continue
        for other_index, other in enumerate(events):
            simultaneous = other["kind"] in SEAL_KINDS
            if other["kind"] not in (*SEAL_KINDS, "break", "volume") or (simultaneous and other_index <= index):
                continue
            delta = other["minute"] - event["minute"]
            if other["code"] != event["code"] and abs(delta) <= window:
                event["related"].append({k: v for k, v in other.items() if k != "related"} |
                                        {"delta": delta, "interaction_kind": "simultaneous" if simultaneous else other["kind"]})
    return events


def interaction_groups(events, window):
    """Cross-stock seal/seal or seal/change pairs, without unbounded temporal chaining."""
    groups, pending = [], None

    def finish(group):
        ordered = sorted(group["events"].values(), key=lambda e: (e["minute"], clock_seconds(e["time"]), -e["boards"], e["code"], e["kind"]))
        codes = {event["code"] for event in ordered}
        if len(codes) < 2:
            return
        groups.append({"id": "interaction-" + group["anchors"][0],
                       "start": ordered[0]["time"][:5], "end": ordered[-1]["time"][:5],
                       "minute": ordered[0]["minute"], "end_minute": ordered[-1]["minute"],
                       "stock_count": len(codes), "events": ordered,
                       "kinds": sorted({link["kind"] for link in group["links"]}),
                       "links": group["links"]})

    for anchor in sorted((event for event in events if regular_time(event.get("time"))),
                         key=lambda e: (e["minute"], clock_seconds(e["time"]), e["id"])):
        if anchor["kind"] not in SEAL_KINDS:
            continue
        peers = [event for event in anchor.get("related", [])
                 if event["code"] != anchor["code"] and event["kind"] in (*SEAL_KINDS, "break", "volume")
                 and regular_time(event.get("time"))
                 and abs(event["minute"] - anchor["minute"]) <= window]
        if not peers:
            continue
        members = {event["id"]: {k: v for k, v in event.items() if k not in ("related", "delta", "interaction_kind")} for event in [anchor, *peers]}
        low, high = min(event["minute"] for event in members.values()), max(event["minute"] for event in members.values())
        if pending and (anchor["minute"] - pending["last_anchor"] > window
                        or max(high, pending["high"]) - min(low, pending["low"]) > 2 * window):
            finish(pending)
            pending = None
        if pending is None:
            pending = {"anchors": [], "events": {}, "links": [], "low": low, "high": high}
        pending["anchors"].append(anchor["id"])
        pending["events"].update(members)
        pending["links"].extend({"anchor_id": anchor["id"], "event_id": event["id"],
                                 "delta": event["minute"] - anchor["minute"],
                                 "kind": "simultaneous" if event["kind"] in SEAL_KINDS else event["kind"]} for event in peers)
        pending["low"], pending["high"] = min(low, pending["low"]), max(high, pending["high"])
        pending["last_anchor"] = anchor["minute"]
    if pending:
        finish(pending)
    return sorted(groups, key=lambda group: (group["minute"], group["end_minute"], group["id"]))


def timeline(archive_path, day, window=2, multiple=10, *, exclude_gem=True, include_live=False):
    intraday.validate_day(day)
    if not isinstance(window, int) or not 0 <= window <= 10:
        raise ValueError("关联窗口应为0至10分钟，0表示同一分钟")
    if not math.isfinite(float(multiple)) or not 10 <= float(multiple) <= 100:
        raise ValueError("放量倍数应为10至100倍")
    if not isinstance(exclude_gem, bool):
        raise ValueError("创业板屏蔽选项无效")
    multiple = float(multiple)
    excluded = {r["code"] for r in intraday.catalog(archive_path) if db.is_st_name(r["name"])}
    with closing(db.connect(archive_path)) as conn:
        if day not in intraday.trading_dates(conn, include_live=include_live):
            raise ValueError("该日期不在项目已知交易日历中")
        snapshot = live_pool.snapshot(conn, day) if include_live else None
        records = snapshot["records"] if snapshot else conn.execute("SELECT date,code,name,boards,close,first_time,last_time,open_times FROM events WHERE date=? ORDER BY boards DESC,code", (day,))
        pool = [dict(r) for r in records
                if (intraday.is_mainboard(r["code"]) or not exclude_gem and db.market_for(r["code"]) == "创业板")
                and not db.is_st_name(r["name"]) and r["code"] not in excluded]
        db.enrich_industries(conn, pool)
    time_coverage = {"cached": False, "missing": sum(not r.get("first_time") for r in pool)} if snapshot else enrich_seal_times(archive_path, day, pool)
    if snapshot:
        for stock in pool:
            stock["clock_source"] = "盘中暂定池"
    sessions, errors = intraday._cached(archive_path, day=day, detail=True)
    events, jobs, analyzed, partial = [], [], 0, 0
    for stock in pool:
        cached = sessions.get((day, stock["code"]))
        points = json.loads(cached["points_json"]) if cached else []
        auction = intraday.auction_view(archive_path, day, stock["code"]) if points else {}
        if points:
            analyzed += 1
            partial += cached["status"] != "ok"
        if not points or cached["status"] != "ok" or auction.get("status") == "unchecked":
            jobs.append({"code": stock["code"], "name": stock["name"], "force": bool(points and cached["status"] != "ok")})
        events.extend(stock_events(stock, points, auction, multiple, previous_close=cached["previous_close"] if cached else None))
    events = associate(events, window)
    return {"date": day, "window": window, "multiple": multiple, "pool": pool, "provisional": bool(snapshot),
            "scope": {"start_time": "09:30", "exclude_st": True, "exclude_gem": exclude_gem},
            "coverage": {"total": len(pool), "analyzed": analyzed, "partial": partial, "missing": len(pool) - analyzed},
            "jobs": jobs, "events": events, "interactions": interaction_groups(events, window), "time_coverage": time_coverage, "generated_at": db.now_iso()}
