"""Add public verified suspension evidence; never replace archive or personal rows."""
from contextlib import closing
from pathlib import Path
import gzip
import hashlib
import json
import database as db

RESOURCE = Path(__file__).resolve().parent / "resources/suspensions.json.gz"


def apply(path, resource=RESOURCE):
    raw = resource.read_bytes()
    identity = hashlib.sha256(raw).hexdigest()
    with closing(db.connect(path)) as conn, conn:
        previous = conn.execute("SELECT value FROM settings WHERE key='published_suspensions'").fetchone()
        if previous and json.loads(previous[0]) == identity:
            return
        seed = json.loads(gzip.decompress(raw))
        conn.executemany("INSERT OR IGNORE INTO verified_suspension_days VALUES (?,?,?,?)", seed["days"])
        conn.executemany("INSERT OR IGNORE INTO suspension_gap_checks VALUES (?,?,?,?,?,'[]',NULL)", seed["checks"])
        conn.execute("INSERT OR REPLACE INTO settings VALUES ('published_suspensions',?)", (json.dumps(identity),))
