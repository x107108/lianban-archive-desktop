"""Publish verified prices and outcomes only, without raw files or user data."""
from contextlib import closing
import argparse
import gzip
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from seven_boards import BROKEN_POOL_SOURCE, archive_runs


def export(source, output, baostock_dir=None):
    recovered = {}
    if baostock_dir:
        for path in sorted(baostock_dir.glob("baostock-*.jsonl")):
            for line in path.read_text(encoding="utf-8").splitlines():
                row = json.loads(line)
                assert row[4] == 5
                recovered[tuple(row[:2])] = row
    with closing(sqlite3.connect((source / "archive.sqlite3").resolve().as_uri() + "?mode=ro", uri=True)) as archive, \
         closing(sqlite3.connect((source / "intraday.sqlite3").resolve().as_uri() + "?mode=ro", uri=True)) as cache:
        archive.row_factory = sqlite3.Row
        archive.execute("BEGIN")
        cache.execute("BEGIN")
        runs, unchecked = archive_runs(archive, cache)
        keys = sorted({(day["date"], run["code"]) for run in runs for day in run["days"] if day})
        minutes = []
        for day, code in keys:
            row = cache.execute("SELECT previous_close,points_json FROM sessions WHERE date=? AND code=? AND status='ok' "
                                "AND (source LIKE '腾讯%' OR source LIKE '东方财富%')",
                                (day, code)).fetchone()
            if row:
                prices = [[p["slot"], p["price"]] for p in json.loads(row[1])]
                minutes.append((day, code, row[0], json.dumps(prices, separators=(",", ":")), 1))
                continue
            row = cache.execute("SELECT previous_close,points_json,interval FROM seven_minutes WHERE date=? AND code=? AND interval=5",
                                (day, code)).fetchone()
            if row:
                prices = [[slot, price] for slot, price in json.loads(row[1])]
                minutes.append((day, code, row[0], json.dumps(prices, separators=(",", ":")), row[2]))
            elif (day, code) in recovered:
                minutes.append(recovered[(day, code)])
        confirmed = {row[0] for row in archive.execute("SELECT date FROM days WHERE status='ok'")}
        fields = ("date", "code", "name", "market", "boards", "stock_type", "close", "pct_change", "first_time", "broken_time")
        broken = [(day, json.dumps([{key: row[key] for key in fields} for row in json.loads(rows)],
                                   ensure_ascii=False, separators=(",", ":")), origin, stamp)
                  for day, rows, origin, stamp in cache.execute(
                      "SELECT date,stocks_json,source,fetched_at FROM broken_pools WHERE source=? ORDER BY date",
                      (BROKEN_POOL_SOURCE,)) if day in confirmed and stamp >= day + "T15:00"]
        halts = [row for row in cache.execute("SELECT date,code FROM seven_halts ORDER BY date,code") if row[0] in confirmed]
    seed = {"minutes": minutes, "broken": broken, "halts": halts}
    output.write_bytes(gzip.compress(json.dumps(seed, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0))
    return {"cycles": len(runs), "charts": len(minutes), "minute_charts": sum(row[4] == 1 for row in minutes), "missing": len(keys)-len(minutes),
            "broken_dates": len(broken), "halts": len(halts), "unchecked_dates": len(unchecked)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--baostock-dir", type=Path)
    args = parser.parse_args()
    print(json.dumps(export(args.source, args.output, args.baostock_dir)))
