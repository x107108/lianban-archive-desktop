"""Deleted tag spellings are reusable without restoring old stock assignments."""
import json
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import database as db
import tag_management as tags


class DeletedTagReuseTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.save_day(self.conn, "2026-11-05", [
            {"code": code, "name": code, "boards": 1} for code in ("000001", "000002", "000003")], "synthetic")
        db.set_settings(self.conn, default_tag_mode="concept_intersection")
        db.save_default_tags(self.conn, [{"code": code, "tags": ["电商", "保留"], "ths_tags": ["电商", "保留"],
            "cls_tags": ["电商", "保留"], "fetched_at": db.now_iso()} for code in ("000001", "000002")], "synthetic")
        db.save_stock_tags(self.conn, "000001", ["电商", "自定义", "保留"], 0)

    def tearDown(self):
        self.conn.close()

    def revision(self):
        return tags.catalog(self.conn)["revision"]

    def delete(self):
        tags.delete_tag(self.conn, "电商", self.revision(), True)

    def save(self, labels):
        current = db.get_stock_tags(self.conn, "000003")
        return tags.save_stock_tag_paths(self.conn, "000003", labels, current["revision"],
                                         alias_revision=current["tag_alias_revision"])

    def assert_old_assignments_absent(self):
        for code in ("000001", "000002"):
            self.assertNotIn("电商", db.get_stock_tags(self.conn, code)["tags"])
        self.assertNotIn("电商", db.get_stock_tags(self.conn, "000001")["custom_tags"])

    def test_flat_recreate_and_repeated_delete_do_not_restore_old_stocks(self):
        self.delete()
        self.assertIn("电商", self.save(["电商"])["tags"])
        self.assert_old_assignments_absent()
        self.assertEqual(tags.members(self.conn, "电商")["count"], 1)
        self.delete()
        self.assertIn("电商", self.save(["电商"])["tags"])
        self.assert_old_assignments_absent()

    def test_recreate_hierarchy_and_rename_target_start_empty(self):
        for action in ("node", "path", "rename"):
            with self.subTest(action=action):
                self.delete()
                if action == "node":
                    tags.save_node(self.conn, "电商", "", self.revision())
                    self.assertEqual(tags.members(self.conn, "电商")["count"], 0)
                    tags.add_stock(self.conn, "电商", "000003", self.revision())
                elif action == "path":
                    self.save(["消费/电商"])
                    self.assertIn({"name": "电商", "parent": "消费"}, tags.hierarchy(self.conn))
                else:
                    self.save(["新标签"])
                    tags.rename(self.conn, "新标签", "电商", self.revision())
                self.assertEqual(tags.members(self.conn, "电商")["count"], 1)
                self.assert_old_assignments_absent()

    def test_provider_refresh_and_restore_defaults_cannot_revive_deleted_memberships(self):
        raw = [tuple(row) for row in self.conn.execute("SELECT * FROM stock_default_tags")]
        db.save_stock_note(self.conn, "000001", "保留备注", 0)
        db.save_blacklist(self.conn, "000001", "add")
        self.delete()
        self.save(["电商"])
        self.assertEqual([tuple(row) for row in self.conn.execute("SELECT * FROM stock_default_tags")], raw)
        db.save_default_tags(self.conn, [{"code": "000002", "tags": ["电商", "新增来源"], "ths_tags": [],
            "cls_tags": [], "fetched_at": db.now_iso()}], "synthetic")
        current = db.get_stock_tags(self.conn, "000001")
        db.save_stock_tags(self.conn, "000001", [], current["revision"], use_source=True)
        self.assert_old_assignments_absent()
        self.assertEqual(db.get_stock_note(self.conn, "000001")["content"], "保留备注")
        self.assertTrue(db.get_stock_tags(self.conn, "000001")["blacklisted"])
        self.assertEqual(db.get_stock_tags(self.conn, "000003")["tags"], ["电商"])

    def test_renaming_recreated_tag_does_not_capture_deleted_provider_members(self):
        self.delete()
        self.save(["消费/电商"])
        tags.rename(self.conn, "电商", "网上贸易", self.revision())
        self.assertEqual([row["code"] for row in tags.members(self.conn, "网上贸易")["rows"]], ["000003"])
        self.assert_old_assignments_absent()
        self.save(["网上贸易", "消费/电商"])
        self.assertEqual(tags.members(self.conn, "电商")["count"], 1)
        self.assertEqual(tags.members(self.conn, "网上贸易")["count"], 1)

    def test_industry_default_mode_and_case_insensitive_reuse(self):
        db.set_settings(self.conn, default_tag_mode="industry")
        db.save_industries(self.conn, [{"code": "000002", "industry": "Commerce", "industry_level2": "",
            "industry_level3": "", "industry_code": "1", "effective_from": "2020-01-01",
            "source_updated_at": "2026-11-05"}], "synthetic", db.now_iso(), [])
        tags.delete_tag(self.conn, "Commerce", self.revision(), True)
        self.assertEqual(self.save(["commerce"])["tags"], ["commerce"])
        self.assertEqual(db.get_stock_tags(self.conn, "000002")["tags"], [])
        self.assertEqual(tags.members(self.conn, "COMMERCE")["count"], 1)

    def test_legacy_cleanup_is_atomic_and_only_runs_once(self):
        with self.conn:
            self.conn.execute("INSERT INTO deleted_tags VALUES (?,?,?)", ("电商", "电商", db.now_iso()))
            self.conn.execute("INSERT INTO tag_aliases VALUES (?,?)", ("电商", "电商"))
            self.conn.execute("INSERT INTO tag_nodes VALUES (?,?,NULL)", ("电商", "电商"))
            self.conn.execute("DELETE FROM settings WHERE key='tag_deletion_storage'")
        db.set_settings(self.conn, tag_alias_revision=0)
        with self.conn:
            self.conn.execute("CREATE TRIGGER fail_delete_upgrade BEFORE UPDATE ON settings WHEN OLD.key='tag_alias_revision' BEGIN SELECT RAISE(ABORT,'failure'); END")
        before = tuple(self.conn.execute("SELECT tags_json,revision FROM stock_tag_overrides").fetchone())
        with self.assertRaises(sqlite3.IntegrityError):
            tags.migrate_deleted_names(self.conn)
        self.assertEqual(tuple(self.conn.execute("SELECT tags_json,revision FROM stock_tag_overrides").fetchone()), before)
        self.assertIsNone(self.conn.execute("SELECT 1 FROM settings WHERE key='tag_deletion_storage'").fetchone())
        with self.conn:
            self.conn.execute("DROP TRIGGER fail_delete_upgrade")
        tags.migrate_deleted_names(self.conn)
        self.assert_old_assignments_absent()
        self.assertNotIn("电商", json.loads(self.conn.execute("SELECT tags_json FROM stock_tag_overrides").fetchone()[0]))
        self.assertFalse(any(node["name"] == "电商" for node in tags.hierarchy(self.conn)))
        self.save(["消费/电商"])
        tags.migrate_deleted_names(self.conn)
        self.assertEqual(db.get_stock_tags(self.conn, "000003")["tags"], ["电商"])
        self.assert_old_assignments_absent()


if __name__ == "__main__":
    unittest.main()
