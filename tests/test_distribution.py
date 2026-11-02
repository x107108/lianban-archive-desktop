from pathlib import Path
import gzip
import hashlib
import json
import sqlite3
import unittest
import setup_shared

ROOT=Path(__file__).resolve().parents[1]

class DistributionTests(unittest.TestCase):
    def test_source_modules_and_every_ui_asset_match_frozen_local_version(self):
        baseline=json.loads((ROOT/'SOURCE_BASELINE.json').read_text(encoding='utf-8'))
        actual={str(p.relative_to(ROOT)).replace('\\','/') for p in (ROOT/'web').rglob('*') if p.is_file()}
        expected={n for n in baseline['identity_sha256'] if n.startswith('web/')}
        self.assertEqual(actual,expected | {'web/updates.js', 'web/updates.css', 'web/realtime.js', 'web/migration.js', 'web/migration.css'})
        for name,digest in baseline['identity_sha256'].items():
            self.assertEqual(hashlib.sha256((ROOT/name).read_bytes()).hexdigest(),digest,name)

    def test_initial_database_has_no_personal_records_or_source_payloads(self):
        raw=gzip.decompress((ROOT/'resources/archive-seed.sqlite3.gz').read_bytes())
        conn=sqlite3.connect(':memory:')
        try:
            conn.deserialize(raw)
            self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            for table in ('stock_tag_overrides','stock_blacklist','stock_notes'):
                self.assertEqual(conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM events WHERE limit_up_reason IS NOT NULL').fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM days WHERE raw_path IS NOT NULL').fetchone()[0],0)
            self.assertGreater(conn.execute('SELECT COUNT(*) FROM events').fetchone()[0],100000)
        finally:
            conn.close()
        for marker in ('C:\\Users\\107108','codex-模型搜索'):
            self.assertNotIn(marker.encode('utf-8'),raw)

    def test_wheel_paths_cannot_escape_runtime(self):
        destination=ROOT/'.runtime/test-python/Lib/site-packages'
        for name in ('../file','/absolute','pkg/../../file','C:/file','pkg\\file'):
            with self.assertRaises(ValueError): setup_shared.wheel_target(name,destination)
        self.assertEqual(setup_shared.wheel_target('package/module.py',destination),destination/'package/module.py')
        self.assertEqual(setup_shared.wheel_target('xlrd.data/scripts/runxlrd.py',destination),destination.parents[1]/'Scripts/runxlrd.py')

    def test_bundle_integrity(self):
        setup_shared.verify()

if __name__=='__main__': unittest.main()
