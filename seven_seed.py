"""Merge the published seven-board history into the local public price cache."""
from contextlib import closing
import gzip
import hashlib
import json
from pathlib import Path

import intraday

RESOURCE = Path(__file__).resolve().parent / "resources/seven-boards.json.gz"


def apply(path, resource=RESOURCE):
    with closing(intraday.connect(intraday.store_path(path))) as conn, conn:
        installed = conn.execute("SELECT value FROM universe_meta WHERE key='seven_seed'").fetchone()
        raw = resource.read_bytes()
        identity = hashlib.sha256(raw).hexdigest()
        if installed and installed[0] == identity:
            return
        seed = json.loads(gzip.decompress(raw))
        conn.executemany(
            "INSERT INTO seven_minutes VALUES (?,?,?,?,?) ON CONFLICT(date,code) DO UPDATE SET "
            "previous_close=excluded.previous_close,points_json=excluded.points_json,interval=excluded.interval "
            "WHERE excluded.interval < seven_minutes.interval", seed["minutes"])
        conn.executemany("INSERT OR IGNORE INTO seven_halts VALUES (?,?)", seed["halts"])
        conn.executemany(
            "INSERT INTO broken_pools VALUES (?,?,?,?,'') ON CONFLICT(date) DO UPDATE SET "
            "stocks_json=excluded.stocks_json,source=excluded.source,fetched_at=excluded.fetched_at,raw_path='' "
            "WHERE broken_pools.source!=excluded.source OR broken_pools.fetched_at<excluded.fetched_at", seed["broken"])
        conn.execute("INSERT OR REPLACE INTO universe_meta VALUES ('seven_seed',?)", (identity,))
