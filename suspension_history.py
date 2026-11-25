"""Verify cycle gaps against dated trading status, never infer halts from absence."""
from contextlib import closing, contextmanager
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
import argparse
import hashlib
import json
import threading

import database as db

SOURCE = "BaoStock · 不复权日线交易状态"
_session_lock = threading.Lock()
FIELDS = ["date", "code", "close", "preclose", "volume", "tradestatus"]


@contextmanager
def baostock_session():
    # BaoStock keeps one process-global socket; the 777 collectors share this lock.
    import baostock
    import baostock.common.context as context
    with _session_lock:
        login = baostock.login()
        if login.error_code != "0":
            raise ValueError(login.error_msg)
        context.default_socket.settimeout(15)
        try:
            yield baostock
        finally:
            baostock.logout()


def cycle_gaps(conn, *, code=None, latest_only=False, plausible_only=False):
    calendar = sorted(set(db.get_settings(conn).get("calendar_dates", [])) |
                      {r[0] for r in conn.execute("SELECT date FROM days WHERE status='ok'")})
    indices = {day: i for i, day in enumerate(calendar)}
    latest = conn.execute("SELECT MAX(date) FROM days WHERE status='ok'").fetchone()[0]
    checks = {(r["code"], r["previous_date"], r["next_date"]): r for r in conn.execute(
        "SELECT * FROM suspension_gap_checks" + (" WHERE code=?" if code else ""), (code,) if code else ())}
    sql = "SELECT e.* FROM events e JOIN days d ON d.date=e.date AND d.status='ok'"
    if code:
        sql += " WHERE e.code=?"
    elif latest_only:
        sql += " WHERE e.code IN (SELECT code FROM events WHERE date=?)"
    rows = conn.execute(sql + " ORDER BY e.code,e.date", (code,) if code else (latest,) if latest_only else ())
    previous, jobs = None, []
    for row in rows:
        if previous is not None and row["code"] == previous["code"]:
            between = calendar[indices[previous["date"]] + 1:indices[row["date"]]]
            possible = row["boards"] == 1 or row["boards"] == previous["boards"] + 1
            check = checks.get((row["code"], previous["date"], row["date"]))
            checked = check is not None and (check["status"] != "unknown" or
                datetime.now(db.TZ) - datetime.fromisoformat(check["checked_at"]) < timedelta(hours=1))
            price_matches = (row["close"] and previous["close"] and row["pct_change"] is not None and
                abs(row["close"] / (1 + row["pct_change"] / 100) - previous["close"]) <= .02)
            if between and possible and not checked and (not latest_only or row["date"] == latest) and (
                    not plausible_only or price_matches or row["boards"] == previous["boards"] + 1):
                jobs.append({"code": row["code"], "name": row["name"], "previous_date": previous["date"],
                             "next_date": row["date"], "dates": between, "previous_close": previous["close"], "close": row["close"]})
        previous = row
    return jobs


def read_sessions(client, job, start, end, raw_dir):
    symbol = ("sh." if job["code"].startswith("6") else "sz.") + job["code"]
    result = client.query_history_k_data_plus(symbol, ",".join(FIELDS), start_date=start, end_date=end,
                                             frequency="d", adjustflag="3")
    rows = []
    while result.error_code == "0" and result.next():
        rows.append(result.get_row_data())
    payload = {"code": symbol, "start": start, "end": end, "fields": result.fields,
               "error_code": result.error_code, "error": result.error_msg, "rows": rows}
    raw = json.dumps(payload, ensure_ascii=False).encode()
    raw_dir.mkdir(parents=True, exist_ok=True)
    path = raw_dir / f"{job['code']}_{start}_{end}_{hashlib.sha256(raw).hexdigest()[:16]}.json"
    if not path.exists():
        path.write_bytes(raw)
    if result.error_code != "0" or result.fields != FIELDS:
        raise ValueError("历史交易状态来源失败或字段不符：" + result.error_msg)
    sessions = {}
    for values in rows:
        if len(values) != len(FIELDS):
            raise ValueError("历史交易状态记录字段不完整")
        row = dict(zip(FIELDS, values))
        day = row["date"]
        if row["code"] != symbol or not start <= day <= end or day in sessions or row["tradestatus"] not in ("0", "1"):
            raise ValueError("历史交易状态代码、日期或状态不符")
        if row["tradestatus"] == "0" and row["volume"] and Decimal(row["volume"]) != 0:
            raise ValueError("停牌状态与成交量矛盾")
        sessions[day] = row
    return sessions, str(path)


def verify_gap(client, job, raw_dir):
    first = job["dates"][0]
    sessions, raw = read_sessions(client, job, first, first, raw_dir)
    if first not in sessions:
        raise ValueError("来源缺少待核验的交易日")
    if sessions[first]["tradestatus"] == "1":
        return "traded", [], [raw]
    sessions, complete_raw = read_sessions(client, job, job["previous_date"], job["next_date"], raw_dir)
    if any(day not in sessions for day in [job["previous_date"], *job["dates"], job["next_date"]]):
        raise ValueError("历史交易状态区间缺失，保留未确认的周期边界")
    for day, expected in ((job["previous_date"], job["previous_close"]), (job["next_date"], job["close"])):
        if sessions[day]["tradestatus"] != "1" or expected is None or abs(Decimal(sessions[day]["close"]) - Decimal(str(expected))) > Decimal("0.01"):
            raise ValueError("停复牌边界行情与涨停档案不一致")
    halted = [day for day in job["dates"] if sessions[day]["tradestatus"] == "0"]
    return "suspended" if len(halted) == len(job["dates"]) else "traded", halted, [raw, complete_raw]


def collect(path, *, code=None, latest_only=False, plausible_only=False, limit=None, stopped=None):
    with closing(db.connect(path)) as conn:
        jobs = cycle_gaps(conn, code=code, latest_only=latest_only, plausible_only=plausible_only)
    jobs = jobs[:limit] if limit else jobs
    summary = {"checked": 0, "suspended": 0, "traded": 0, "unknown": 0, "cases": []}
    if not jobs:
        return summary
    raw_dir = Path(path).resolve().parent / "suspension_history_raw"
    with baostock_session() as client:
        for job in jobs:
            if stopped is not None and stopped():
                break
            # BaoStock does not provide Beijing-exchange daily history.
            if job["code"].startswith(("4", "8", "92")):
                status, halted, paths, error = "unknown", [], [], "来源不支持北交所，未合并"
            else:
                try:
                    status, halted, paths = verify_gap(client, job, raw_dir)
                    error = None
                except (ValueError, OSError, ArithmeticError) as exc:
                    status, halted, paths, error = "unknown", [], [], str(exc)
            with closing(db.connect(path)) as conn, conn:
                stamp = db.now_iso()
                conn.execute("INSERT INTO suspension_gap_checks VALUES (?,?,?,?,?,?,?) ON CONFLICT(code,previous_date,next_date) "
                             "DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,raw_paths=excluded.raw_paths,error=excluded.error",
                             (job["code"], job["previous_date"], job["next_date"], status, stamp, json.dumps(paths), error))
                before = conn.total_changes
                conn.executemany("INSERT OR IGNORE INTO verified_suspension_days VALUES (?,?,?,?)",
                                 [(day, job["code"], SOURCE, stamp) for day in halted])
                if conn.total_changes != before:
                    db.bump_suspension_revision(conn)
            summary["checked"] += 1
            summary[status] += 1
            if status != "traded":
                summary["cases"].append({**job, "status": status, "error": error})
            if summary["checked"] % 20 == 0 or status == "suspended":
                print(f"停牌核验 {summary['checked']}/{len(jobs)}：确认 {summary['suspended']}，正常交易 {summary['traded']}，待核实 {summary['unknown']}", flush=True)
    if summary["checked"]:
        with closing(db.connect(path)) as conn, conn:
            db.bump_suspension_revision(conn)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="核验涨停周期之间的历史交易状态")
    parser.add_argument("--db", type=Path, default=db.DEFAULT_DB)
    parser.add_argument("--code")
    parser.add_argument("--latest", action="store_true")
    parser.add_argument("--plausible-only", action="store_true")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = collect(args.db, code=args.code, latest_only=args.latest, plausible_only=args.plausible_only, limit=args.limit)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items() if k != "cases"}, ensure_ascii=False), flush=True)
