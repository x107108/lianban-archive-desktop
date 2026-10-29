from contextlib import closing
from pathlib import Path
from uuid import uuid4
import gzip
import json
import unittest

import database as db
import shareholder_seed
import shareholders


class ShareholderSeedTests(unittest.TestCase):
    def test_existing_newer_profiles_and_personal_records_survive_repeated_startup(self):
        path = Path(__file__).parent / 'test-data' / ('shareholder-seed-' + uuid4().hex) / 'archive.sqlite3'
        with closing(db.connect(path)) as conn:
            db.save_day(conn, '2026-10-28', [{'code': code, 'name': code, 'boards': 1} for code in ('000001', '000002')], 'synthetic')
            records = [{'code': '000001', 'holder_key': 'new holder', 'holder_name': '新股东',
                        'holder_type': '个人', 'report_date': '2026-10-28'}]
            shareholders.save_batch(conn, ['000001'], {'total': records, 'float': records})
            db.save_stock_note(conn, '000001', '保留我的备注', 0)
            before = [tuple(row) for row in conn.execute('SELECT * FROM stock_shareholders ORDER BY scope')]
            notes = [tuple(row) for row in conn.execute('SELECT * FROM stock_notes')]
        self.assertEqual(shareholder_seed.apply(path), 2)
        self.assertEqual(shareholder_seed.apply(path), 0)
        with closing(db.connect(path)) as conn:
            self.assertEqual([tuple(row) for row in conn.execute("SELECT * FROM stock_shareholders WHERE code='000001' ORDER BY scope")], before)
            self.assertEqual([tuple(row) for row in conn.execute('SELECT * FROM stock_notes')], notes)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM shareholder_profiles WHERE code='000002'").fetchone()[0], 2)
            self.assertEqual(conn.execute('SELECT COUNT(DISTINCT code) FROM shareholder_profiles').fetchone()[0], 2)

    def test_public_resource_contains_only_shareholder_fields_and_complete_profiles(self):
        with gzip.open(shareholder_seed.RESOURCE, 'rt', encoding='utf-8') as handle:
            seed = json.load(handle)
        self.assertEqual(set(seed), {'source_commit', 'exported_at', 'profiles', 'rows'})
        profile_fields = {'code', 'scope', 'report_date', 'source', 'fetched_at'}
        record_fields = {'code', 'scope', 'holder_key', 'holder_name', 'holder_type', 'report_date'}
        self.assertTrue(all(set(row) == profile_fields for row in seed['profiles']))
        self.assertTrue(all(set(row) == record_fields for row in seed['rows']))
        profiles = {(row['code'], row['scope']): row for row in seed['profiles']}
        self.assertEqual(len(profiles), len(seed['profiles']))
        self.assertGreater(len(seed['rows']), 100000)
        self.assertTrue(all(row['report_date'] == profiles[row['code'], row['scope']]['report_date'] for row in seed['rows']))


if __name__ == '__main__':
    unittest.main()
