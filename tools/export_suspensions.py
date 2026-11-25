"""Export verified public trading status without raw payloads or personal tables."""
from pathlib import Path
import argparse
import gzip
import json
import sqlite3


def export(source, output):
    with sqlite3.connect(Path(source).resolve().as_uri() + "?mode=ro", uri=True) as conn:
        conn.execute("BEGIN")
        days = conn.execute("SELECT date,code,source,checked_at FROM verified_suspension_days "
                            "WHERE source='BaoStock · 不复权日线交易状态' ORDER BY date,code").fetchall()
        checks = conn.execute("SELECT code,previous_date,next_date,status,checked_at FROM suspension_gap_checks "
                              "WHERE status IN ('suspended','traded') ORDER BY code,previous_date,next_date").fetchall()
    Path(output).write_bytes(gzip.compress(json.dumps({"days": days, "checks": checks},
        ensure_ascii=False, separators=(",", ":")).encode(), mtime=0))
    print(json.dumps({"verified_days": len(days), "verified_gaps": len(checks), "personal_data": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    export(args.source, args.output)
