from contextlib import closing
from pathlib import Path
import copy
import json
import unittest
import uuid

import database as db
import personal_data


def fixture():
    return {'format': 'lianban-personal-data', 'version': 1,
      'stocks': [{'code': '000001', 'name': '样本', 'tags': {'values': ['自选'], 'source': ['默认']},
        'notes': [{'content': '线上备注\n第二行', 'occurred_at': '2026-11-02T10:00:00.123Z', 'updated_at': '2026-11-02T11:00:00.000Z', 'note_date': ''}], 'blacklisted': True}],
      'hierarchy': [{'name': '研究', 'parent': ''}, {'name': '自选', 'parent': '研究'}],
      'preferences': {'limit-up-archive.shareholder-blocked-types.v1': '["基金"]'}}


class PersonalDataTests(unittest.TestCase):
    def setUp(self):
        self.path = Path(__file__).parent / 'test-data' / ('migration-' + uuid.uuid4().hex) / 'archive.sqlite3'
        with closing(db.connect(self.path)) as conn:
            db.save_day(conn, '2026-11-02', [{'code': '000001', 'name': '样本', 'boards': 1}], 'synthetic')
            db.save_stock_tags(conn, '000001', ['本机标签'], 0)
            db.save_stock_note(conn, '000001', '本机备注', 0)

    def test_merge_keeps_local_data_history_dates_and_snapshot(self):
        result = personal_data.import_data(self.path, personal_data.validate(fixture()))
        self.assertEqual(result['added_notes'], 1)
        self.assertEqual(result['added_blacklist'], 1)
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(set(db.get_stock_tags(conn, '000001')['tags']), {'自选', '本机标签'})
            notes = db.get_stock_note(conn, '000001')['entries']
            self.assertEqual({n['content'] for n in notes}, {'本机备注', '线上备注\n第二行'})
            self.assertEqual(next(n['note_date'] for n in notes if n['content'].startswith('线上')), '')
            self.assertEqual(conn.execute("SELECT parent_key FROM tag_nodes WHERE tag_key='自选'").fetchone()[0], '研究')
            facts = conn.execute('SELECT COUNT(*) FROM events').fetchone()[0]
        backup = self.path.parent / 'backups' / Path(result['backup']).name
        with closing(sqlite3.connect(backup)) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM stock_note_entries').fetchone()[0], 1)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM events').fetchone()[0], facts)

    def test_repeated_file_and_changed_export_do_not_duplicate_notes(self):
        clean = personal_data.validate(fixture())
        personal_data.import_data(self.path, clean)
        self.assertTrue(personal_data.import_data(self.path, clean)['already_imported'])
        changed = fixture()
        changed['stocks'][0]['tags']['values'].append('新标签')
        self.assertEqual(personal_data.import_data(self.path, personal_data.validate(changed))['added_notes'], 0)

    def test_corrupt_and_cyclic_payloads_rejected(self):
        for mutate in (lambda d: d.update(format='wrong'), lambda d: d['stocks'][0].update(code='../../'),
                       lambda d: d['hierarchy'][0].update(parent='自选'),
                       lambda d: d['stocks'][0]['notes'][0].update(note_date='2026-02-30'),
                       lambda d: d['stocks'][0]['notes'][0].update(content='bad\x00text')):
            data = fixture()
            mutate(data)
            with self.assertRaises(ValueError): personal_data.validate(data)

    def test_deleted_history_unknown_stock_and_local_hierarchy_conflict(self):
        data = fixture()
        data['stocks'][0]['code'] = '999999'
        data['stocks'][0]['notes'][0]['deleted_at'] = '2026-11-02T12:00:00Z'
        with closing(db.connect(self.path)) as conn:
            with conn: conn.execute("INSERT INTO tag_nodes VALUES ('自选','自选',NULL)")
        result = personal_data.import_data(self.path, personal_data.validate(data))
        self.assertEqual(result['hierarchy_conflicts'], 1)
        with closing(db.connect(self.path)) as conn:
            self.assertEqual(db.get_stock_note(conn, '999999')['entries'], [])
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM stock_note_entries WHERE code=?', ('999999',)).fetchone()[0], 1)


import sqlite3
if __name__ == '__main__': unittest.main()
