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
        self.assertEqual(set(seed), {'source_commit', 'exported_at', 'profiles', 'rows', 'control_profiles', 'control_rows', 'subsidiaries'})
        profile_fields = {'code', 'scope', 'report_date', 'source', 'fetched_at', 'ratio_checked'}
        record_fields = {'code', 'scope', 'holder_key', 'holder_name', 'holder_type', 'report_date', 'holding_ratio'}
        self.assertTrue(all(set(row) == profile_fields for row in seed['profiles']))
        self.assertTrue(all(set(row) == record_fields for row in seed['rows']))
        profiles = {(row['code'], row['scope']): row for row in seed['profiles']}
        self.assertEqual(len(profiles), len(seed['profiles']))
        self.assertGreater(len(seed['rows']), 100000)
        self.assertTrue(all(row['report_date'] == profiles[row['code'], row['scope']]['report_date'] for row in seed['rows']))
        self.assertTrue(all(set(row)=={'code','source','fetched_at'} for row in seed['control_profiles']))
        self.assertTrue(all(set(row)=={'code','kind','holder_key','holder_name','holder_type','via_name','source_url','fetched_at'} for row in seed['control_rows']))
        self.assertTrue(all(set(row)=={'code','disclosure_date','companies_json','source_url','fetched_at','attempted_at'} for row in seed['subsidiaries']))

    def test_legacy_ratio_enrichment_requires_same_report_and_complete_holder_keys(self):
        path = Path(__file__).parent/'test-data'/('legacy-ratio-'+uuid4().hex)/'archive.sqlite3'
        with gzip.open(shareholder_seed.RESOURCE,'rt',encoding='utf-8') as handle:
            seed=json.load(handle)
        code='000001'
        profiles=[r for r in seed['profiles'] if r['code']==code]
        records=[r for r in seed['rows'] if r['code']==code]
        with closing(db.connect(path)) as conn, conn:
            db.save_day(conn,'2026-10-30',[{'code':code,'name':'测试','boards':1}],'synthetic')
            conn.executemany('INSERT INTO shareholder_profiles(code,scope,report_date,source,fetched_at) VALUES (?,?,?,?,?)',[(code,r['scope'],r['report_date'],r['source'],r['fetched_at']) for r in profiles])
            conn.executemany('INSERT INTO stock_shareholders(code,scope,holder_key,holder_name,holder_type,report_date) VALUES (?,?,?,?,?,?)',[(code,r['scope'],r['holder_key'],r['holder_name'],r['holder_type'],r['report_date']) for r in records])
            db.save_stock_note(conn,code,'只保留用户备注',0)
        self.assertEqual(shareholder_seed.apply(path),0)
        with closing(db.connect(path)) as conn, conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM stock_shareholders WHERE holding_ratio IS NOT NULL').fetchone()[0],sum(r['holding_ratio'] is not None for r in records))
            self.assertEqual(conn.execute('SELECT MIN(ratio_checked) FROM shareholder_profiles').fetchone()[0],1)
            conn.execute('UPDATE stock_shareholders SET holding_ratio=99')
        shareholder_seed.apply(path)
        with closing(db.connect(path)) as conn:
            self.assertEqual(conn.execute('SELECT MIN(holding_ratio) FROM stock_shareholders').fetchone()[0],99)
            self.assertIn('只保留用户备注',conn.execute('SELECT content FROM stock_notes').fetchone()[0])


if __name__ == '__main__':
    unittest.main()
