"""Seven-board runs and their historical intraday price lines."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, nullcontext
from datetime import date, datetime, timedelta
import json
from pathlib import Path
import sqlite3

import database as db
import intraday
from intraday_sources import BROKEN_POOL_SOURCE, fetch_broken_pool, fetch_json, tencent_reference
from provider import ProviderError


def archive_runs(archive, cache, *, since=None):
    settings = db.get_settings(archive)
    confirmed = {r[0] for r in archive.execute("SELECT date FROM days WHERE status='ok'")}
    calendar = sorted(confirmed | set(settings.get("calendar_dates") or []))
    index = {day: i for i, day in enumerate(calendar)}
    suspensions = {(row["date"], row["code"]) for row in archive.execute(
        "SELECT date,code FROM suspension_records WHERE full_day=1")}
    if cache and cache.execute("SELECT 1 FROM sqlite_master WHERE name='seven_halts'").fetchone():
        suspensions.update(tuple(row) for row in cache.execute("SELECT date,code FROM seven_halts"))
    start = settings.get("range_start") or ""
    refresh_start = max(start, since or "")
    broken_days = {}
    if cache and cache.execute("SELECT 1 FROM sqlite_master WHERE name='broken_pools'").fetchone():
        for day, rows, source, fetched_at in cache.execute("SELECT date,stocks_json,source,fetched_at FROM broken_pools WHERE date>=?", (refresh_start,)):
            # A same-day capture during trading can include stocks that seal again.
            if fetched_at >= f"{day}T15:00":
                broken_days[day] = ({row["code"]: row for row in json.loads(rows)}, source)

    columns = "e.date,e.code,e.name,e.market,e.industry,e.boards,e.close,e.pct_change,e.first_time,e.open_times"
    seeds = archive.execute(f"SELECT {columns} FROM events e JOIN days d ON d.date=e.date AND d.status='ok' "
                            "WHERE e.boards IN (6,7) ORDER BY e.date DESC,e.code")
    seventh, unchecked = [], set()
    for row in seeds:
        if row["boards"] == 7:
            if row["date"] >= start:
                seventh.append((dict(row), "resealed" if row["open_times"] else "sealed"))
            continue
        next_index = index[row["date"]] + 1
        if next_index == len(calendar):
            continue
        day = calendar[next_index]
        if day < refresh_start or day not in confirmed or archive.execute(
                "SELECT 1 FROM events WHERE date=? AND code=?", (day, row["code"])).fetchone():
            continue
        broken, source = broken_days.get(day, ({}, ""))
        if source != BROKEN_POOL_SOURCE:
            unchecked.add(day)
        if row["code"] in broken:
            seventh.append((broken[row["code"]], "broken"))

    runs = []
    seventh.sort(key=lambda item: item[0]["code"])
    for final, outcome in sorted(seventh, key=lambda item: item[0]["date"], reverse=True):
        board_days = [None] * 6 + [final]
        for offset in range(1, 7):
            i = index[final["date"]] - offset
            if i < 0 or calendar[i] not in confirmed:
                break
            row = archive.execute(f"SELECT {columns} FROM events e WHERE date=? AND code=? AND boards=?",
                                  (calendar[i], final["code"], 7 - offset)).fetchone()
            if row is None:
                break
            board_days[6 - offset] = dict(row)
        if outcome != "broken":
            for day in calendar[index[final["date"]] + 1:]:
                if day not in confirmed:
                    break
                if (day, final["code"]) in suspensions:
                    continue
                row = archive.execute(f"SELECT {columns} FROM events e WHERE date=? AND code=?",
                                      (day, final["code"])).fetchone()
                if row and row["boards"] == len(board_days) + 1:
                    board_days.append(dict(row))
                    continue
                broken, source = broken_days.get(day, ({}, ""))
                if not row and day >= refresh_start and source != BROKEN_POOL_SOURCE:
                    unchecked.add(day)
                failed = broken.get(final["code"]) if not row else None
                attempt = dict(row) if row else failed or {"date": day, "code": final["code"]}
                board_days.append({**attempt, "terminal": "broken" if failed else "reset" if row else "unsealed"})
                break
        if not since or board_days[-1]["date"] >= since:
            runs.append({"code": final["code"], "name": final["name"], "market": final["market"],
                         "industry": final.get("industry"), "date": final["date"], "outcome": outcome, "days": board_days})
    return runs, unchecked


def board_type(day, *, broken=False):
    if broken:
        return "broken"
    if not day or not day["first_time"]:
        return "unknown"
    if day["first_time"] > "09:30:00":
        return "intraday"
    if day["first_time"] < "09:25:00" or day["open_times"] is None:
        return "unknown"
    return "t_shape" if day["open_times"] > 0 else "one_price"


def view(archive_path, *, exclude_st=True, exclude_gem=True, include_notes=True):
    path = intraday.store_path(archive_path)
    cached = closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) if path.is_file() else nullcontext()
    with closing(db.connect(archive_path)) as archive, cached as cache:
        runs, unchecked = archive_runs(archive, cache)
        yearly_sealed = {run["date"][:4]: set() for run in runs}
        runs = [run for run in runs
                if (not exclude_st or not db.is_st_name(run["name"]))
                and (not exclude_gem or not run["code"].startswith(("300", "301")))]
        db.enrich_industries(archive, runs)
        board_types = [dict.fromkeys(("one_price", "t_shape", "intraday", "broken", "unknown", "opened"), 0) for _ in range(7)]
        tables = {r[0] for r in cache.execute("SELECT name FROM sqlite_master WHERE type='table'")} if cache else set()
        for run in runs:
            if run["outcome"] != "broken":
                yearly_sealed[run["date"][:4]].add(run["code"])
            for board, day in enumerate(run["days"]):
                if board < 7:
                    kind = board_type(day, broken=board == 6 and run["outcome"] == "broken")
                    board_types[board][kind] += 1
                    if kind == "broken" or (day and (day.get("open_times") or 0) > 0):
                        board_types[board]["opened"] += 1
                if day is None:
                    continue
                key = (day["date"], run["code"])
                minute = cache.execute("SELECT previous_close,points_json,status,source FROM sessions WHERE date=? AND code=?", key).fetchone() if "sessions" in tables else None
                history = cache.execute("SELECT previous_close,points_json,interval FROM seven_minutes WHERE date=? AND code=?", key).fetchone() if "seven_minutes" in tables else None
                if minute and (minute[2] == "ok" or not history):
                    day.update(previous_close=minute[0], points=[[p["slot"], p["price"]] for p in json.loads(minute[1])],
                               status=minute[2], minute_source=minute[3])
                elif history:
                    interval = history[2]
                    day.update(previous_close=history[0], points=json.loads(history[1]), status="ok", interval=interval,
                               minute_source="公开 1 分钟行情" if interval == 1 else "BaoStock 5 分钟行情")
                if day.get("terminal") == "unsealed" and day.get("status") == "ok":
                    day["pct_change"] = round((day["points"][-1][1] / day["previous_close"] - 1) * 100, 2)
            if not include_notes:
                run.pop("note")
    return {"rows": runs, "total": len(runs), "board_types": board_types, "unchecked_dates": len(unchecked),
            "yearly_sealed": {year: len(codes) for year, codes in yearly_sealed.items()}}


def checked_prices(day, points, interval, *, reference=None):
    close = day.get("close")
    if ([point[0] for point in points] != list(range(interval, 241, interval))
            or (close is not None and abs(points[-1][1] - close) > max(0.02, close * 0.0005))):
        raise ValueError("分时不完整或收盘价不一致")
    previous = (intraday.previous_close(day) if close is not None and reference is None
                else intraday.number(reference, positive=True))
    return day["date"], day["code"], previous, json.dumps(points, separators=(",", ":")), interval


def five_minute_prices(days, cache):
    import baostock

    login = baostock.login()
    if login.error_code != "0":
        raise ValueError(login.error_msg)
    try:
        for day in days:
            code, trade_date = day["code"], day["date"]
            symbol = ("sh." if code.startswith("6") else "sz.") + code
            try:
                reference = None
                if day.get("close") is None:
                    daily = baostock.query_history_k_data_plus(symbol, "date,code,close,preclose,tradestatus",
                                start_date=trade_date,
                                end_date=(date.fromisoformat(trade_date) + timedelta(days=30)).isoformat(),
                                frequency="d", adjustflag="3")
                    if daily.error_code != "0" or not daily.next():
                        raise ValueError("缺少日行情")
                    row_date, row_symbol, close, previous, traded = daily.get_row_data()
                    if row_date != trade_date or row_symbol != symbol:
                        raise ValueError("交易日期或代码不一致")
                    if traded == "0":
                        halted = [(trade_date, code)]
                        while daily.next():
                            row_date, row_symbol, _, _, traded = daily.get_row_data()
                            if row_symbol != symbol or traded != "0":
                                break
                            halted.append((row_date, code))
                        with cache:
                            cache.executemany("INSERT OR IGNORE INTO seven_halts VALUES (?,?)", halted)
                        continue
                    if traded != "1":
                        raise ValueError("交易状态不明")
                    day = {**day, "close": intraday.number(close, positive=True)}
                    reference = intraday.number(previous, positive=True)
                result = baostock.query_history_k_data_plus(symbol, "date,time,code,close",
                            start_date=trade_date, end_date=trade_date, frequency="5", adjustflag="3")
                if result.error_code != "0":
                    raise ValueError(result.error_msg)
                points = []
                while result.next():
                    row_date, stamp, row_symbol, price = result.get_row_data()
                    if row_date != trade_date or row_symbol != symbol:
                        raise ValueError("行情日期或代码不一致")
                    points.append([intraday.session_slot(f"{stamp[8:10]}:{stamp[10:12]}"), intraday.number(price, positive=True)])
                yield checked_prices(day, points, 5, reference=reference)
            except (ValueError, TypeError) as exc:
                print(f"777 5分钟 {trade_date} {code}: {exc}", flush=True)
    finally:
        baostock.logout()


def collect(archive_path, *, recent=False, five_minute=False):
    """Refresh candidate break dates and only fetch minute charts for qualifying runs."""
    import requests

    since = (datetime.now(db.TZ).date() - timedelta(days=14)).isoformat() if recent else None

    def broken(day):
        try:
            fetch_broken_pool(archive_path, day)
        except (requests.RequestException, ProviderError, ValueError, TypeError, KeyError) as exc:
            print(f"777 破板池 {day}: {exc}", flush=True)

    with closing(db.connect(archive_path)) as archive, closing(intraday.connect(intraday.store_path(archive_path))) as cache:
        _, unchecked = archive_runs(archive, cache, since=since)
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(broken, sorted(unchecked, reverse=True)))
        runs, unchecked = archive_runs(archive, cache, since=since)
        ready = {tuple(row) for row in cache.execute("SELECT date,code FROM seven_minutes WHERE interval<=? "
                     "UNION SELECT date,code FROM sessions WHERE status='ok'", (5 if five_minute else 1,))}
        pending = {(day["date"], day["code"]): day for run in runs for day in run["days"]
                   if day is not None and (not since or run["date"] >= since or day["date"] >= since)
                   and (day["date"], day["code"]) not in ready}
        print(f"777 周期 {len(runs)}，待核对破板日期 {len(unchecked)}，待补分时 {len(pending)}", flush=True)
        if not pending:
            return

        def save(rows):
            saved = 0
            for row in rows:
                if row:
                    with cache:
                        cache.execute("INSERT INTO seven_minutes VALUES (?,?,?,?,?) ON CONFLICT(date,code) DO UPDATE SET "
                                      "previous_close=excluded.previous_close, points_json=excluded.points_json, interval=excluded.interval "
                                      "WHERE excluded.interval < seven_minutes.interval", row)
                    saved += 1
            print(f"777 分时已补 {saved}/{len(pending)}", flush=True)

        if five_minute:
            save(five_minute_prices(pending.values(), cache))
            return


        raw_dir = Path(archive_path).resolve().parent / "intraday_raw"

        def fetch(day):
            code, trade_date = day["code"], day["date"]
            if code.startswith(("4", "8", "92")):
                return None
            symbol = ("sh" if code.startswith("6") else "sz") + code
            try:
                payload, _ = fetch_json(intraday.TENCENT_URL, {"code": symbol}, raw_dir, f"seven_{code}")
                points = intraday.normalize_tencent(payload, day)
                if day.get("close") is None and not any(point["volume"] > 0 for point in points):
                    return None
                reference = tencent_reference(payload, symbol, trade_date)[0] if day.get("close") is None else None
                prices = [[intraday.session_slot(point["time"]), intraday.number(point["price"], positive=True)]
                          for point in points]
                return checked_prices(day, [point for point in prices if point[0] > 0], 1, reference=reference)
            except (requests.RequestException, ProviderError, ValueError, TypeError, KeyError) as exc:
                print(f"777 分时 {trade_date} {code}: {exc}", flush=True)
                return None

        with ThreadPoolExecutor(max_workers=3) as pool:
            save(pool.map(fetch, pending.values()))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="补采 777 模块所需的公开历史分时")
    parser.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    parser.add_argument("--five-minute", action="store_true", help="使用单独安装的 BaoStock 补齐 5 分钟历史行情")
    args = parser.parse_args()
    collect(args.db, five_minute=args.five_minute)
