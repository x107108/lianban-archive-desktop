"""Build a new, sanitized archive without copying source database free pages."""
from pathlib import Path
import argparse
import gzip
import hashlib
import json
import re
import sqlite3
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import database as db

TABLES = ('days', 'stocks', 'events', 'stock_industries', 'company_registrations',
          'suspension_days', 'suspension_records', 'verified_suspension_days')
KEYS = {'calendar_dates', 'calendar_source', 'calendar_url', 'coverage_note', 'coverage_status',
        'extension_2020_completed_at', 'industry_count', 'industry_fetched_at', 'industry_source',
        'industry_status', 'latest_date', 'method_note', 'missing_dates', 'range_end', 'range_start',
        'registration_count', 'registration_fetched_at', 'registration_requested', 'registration_source',
        'registration_status', 'registration_storage', 'registration_unavailable_codes', 'scope_note',
        'source', 'source_url', 'suspension_revision', 'warmup_start'}

def build(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    if not source.is_file() or output.exists():
        raise ValueError('Source must exist and output must be a new file.')
    work = ROOT / '.build'
    work.mkdir(exist_ok=True)
    clean = work / ('sanitized-' + uuid.uuid4().hex + '.sqlite3')
    src = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)
    src.row_factory = sqlite3.Row
    src.execute('BEGIN')
    dst = db.connect(clean)
    counts = {}
    try:
        for table in TABLES:
            columns = [r[1] for r in dst.execute(f'PRAGMA table_info({table})')]
            count = 0
            for row in src.execute(f'SELECT * FROM {table}'):
                item = dict(row)
                for key in ('raw_path', 'raw_paths', 'error', 'limit_up_reason'):
                    if key in item:
                        item[key] = None
                if table == 'company_registrations':
                    item.update(city='', location='', address='')
                if table == 'days':
                    item['note'] = re.sub(r'[A-Za-z]:[\\/][^\s,;，；]+', '[local source]', item['note'])
                dst.execute(f'INSERT INTO {table} VALUES ({",".join("?" for _ in columns)})',
                            [item[c] for c in columns])
                count += 1
            counts[table] = count
        for row in src.execute('SELECT key,value FROM settings'):
            if row['key'] in KEYS:
                dst.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', tuple(row))
        dst.commit()
        assert all(dst.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0] == 0
                   for t in ('stock_tag_overrides', 'stock_blacklist', 'stock_notes'))
        assert dst.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        visible = dst.execute('SELECT MIN(date),MAX(date),COUNT(*) FROM events WHERE date>=?',
                              (db.REQUEST_START,)).fetchone()
        dst.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        dst.execute('PRAGMA journal_mode=DELETE')
    finally:
        src.close()
        dst.close()
    raw = clean.read_bytes()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as handle:
        handle.write(gzip.compress(raw, compresslevel=9, mtime=0))
    report = {'database_sha256': hashlib.sha256(raw).hexdigest(), 'database_bytes': len(raw),
              'gzip_sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'table_counts': counts,
              'visible_start': visible[0], 'visible_end': visible[1], 'visible_events': visible[2],
              'personal_tags': 0, 'blacklist': 0, 'personal_notes': 0,
              'raw_source_payloads_included': False, 'third_party_reason_text_included': False,
              'source_free_pages_copied': False}
    output.with_suffix('.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-db', required=True, type=Path)
    parser.add_argument('--output', type=Path, default=ROOT/'resources/archive-seed.sqlite3.gz')
    args = parser.parse_args()
    build(args.source_db, args.output)
