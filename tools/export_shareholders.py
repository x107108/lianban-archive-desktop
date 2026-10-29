"""Export only the normalized, public shareholder cache, never the source database."""
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import argparse
import gzip
import json
import sqlite3


def export(source, target, source_commit):
    with closing(sqlite3.connect(Path(source).resolve().as_uri() + '?mode=ro', uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute('BEGIN')
        profiles = [dict(row) for row in conn.execute(
            'SELECT p.code,p.scope,p.report_date,p.source,p.fetched_at FROM shareholder_profiles p '
            'JOIN stocks s ON s.code=p.code ORDER BY p.code,p.scope')]
        rows = [dict(row) for row in conn.execute(
            'SELECT p.code,p.scope,p.holder_key,p.holder_name,p.holder_type,p.report_date '
            'FROM stock_shareholders p JOIN stocks s ON s.code=p.code ORDER BY p.code,p.scope,p.holder_key')]
    value = {'source_commit': source_commit, 'exported_at': datetime.now(timezone.utc).isoformat(),
             'profiles': profiles, 'rows': rows}
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(gzip.compress(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode(), mtime=0))
    return {'profiles': len(profiles), 'stocks': len({row['code'] for row in rows}),
            'rows': len(rows), 'bytes': target.stat().st_size}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--target', required=True, type=Path)
    parser.add_argument('--source-commit', required=True)
    args = parser.parse_args()
    print(json.dumps(export(args.source, args.target, args.source_commit)))
