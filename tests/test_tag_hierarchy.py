"""Hierarchy changes preserve independent stock memberships and survive aliases."""
from contextlib import nullcontext
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import database as db
import tag_management as tags
import app


class HierarchyTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.save_day(self.conn, "2026-10-27", [{"code": code, "name": code, "boards": 1} for code in ("000001", "000002", "000003")], "synthetic")
        for code, labels in (("000001", ["机械", "人形"]), ("000002", ["仿生"]), ("000003", ["汽车"])):
            db.save_stock_tags(self.conn, code, labels, 0)

    def tearDown(self):
        self.conn.close()

    def revision(self):
        return tags.catalog(self.conn)["revision"]

    def node(self, name, parent="", action="create"):
        return tags.save_node(self.conn, name, parent, self.revision(), action)

    def tree(self):
        return {node["name"]: node["parent"] for node in tags.hierarchy(self.conn)}

    def setup_tree(self):
        self.node("机器人")
        self.node("机械", "机器人", "parent")
        self.node("人形", "机械", "parent")
        self.node("仿生", "机器人", "parent")

    def test_counts_memberships_and_empty_nodes_are_independent(self):
        before = {code: db.get_stock_tags(self.conn, code)["tags"] for code in ("000001", "000002")}
        self.setup_tree()
        self.assertEqual(self.tree()["人形"], "机械")
        counts = {tag["name"]: tag["count"] for tag in tags.catalog(self.conn)["tags"]}
        self.assertEqual(counts["机器人"], 2)
        self.assertEqual(counts["机械"], 1, "explicit parent plus child never double counts a stock")
        members = tags.members(self.conn, "机器人")
        self.assertEqual(members["direct_count"], 0)
        self.assertFalse(any(row["direct"] for row in members["rows"]))
        for code in before:
            self.assertEqual(db.get_stock_tags(self.conn, code)["tags"], before[code])
        self.conn.execute("UPDATE events SET boards=4 WHERE code='000001'")
        self.conn.commit()
        daily = db.date_view(self.conn, "2026-10-27")
        first = db.date_view(self.conn, "2026-10-27", boards=1)
        self.assertEqual(daily["tag_board_counts"]["机器人"], {"4": 1, "1": 1})
        self.assertEqual(first["tag_board_counts"], daily["tag_board_counts"], "board filtering preserves whole-day parent union counts")
        tags.add_stock(self.conn, "机器人", "000001", self.revision())
        self.assertTrue(tags.members(self.conn, "机器人")["rows"][0]["direct"])
        self.assertEqual(tags.members(self.conn, "机器人")["count"], 2)
        tags.remove_stock(self.conn, "机器人", "000001", self.revision())
        self.assertEqual(tags.members(self.conn, "机器人")["count"], 2, "removing direct parent membership preserves descendants")
        self.node("空父级")
        self.assertEqual(tags.members(self.conn, "空父级")["count"], 0)
        tags.add_stocks(self.conn, "空父级", ["000003"], self.revision())
        self.assertIn("空父级", db.get_stock_tags(self.conn, "000003")["tags"])

    def test_cycles_stale_versions_validation_and_detaching(self):
        self.setup_tree()
        before = self.tree()
        for name, parent in (("机器人", "人形"), ("机械", "机械"), ("机械", "不存在")):
            with self.subTest(name=name, parent=parent), self.assertRaises(ValueError):
                self.node(name, parent, "parent")
            self.assertEqual(self.tree(), before)
        stale = self.revision()
        self.node("人形", "", "parent")
        self.assertEqual(self.tree()["人形"], "")
        with self.assertRaises(db.TagConflictError):
            tags.save_node(self.conn, "新父级", "", stale)
        for name in (None, "", "a" * 31, "坏\n标签"):
            with self.assertRaises(ValueError):
                self.node(name)
        with self.assertRaises(ValueError):
            self.node("机器人")

    def test_renames_merges_and_deletion_preserve_children(self):
        self.setup_tree()
        tags.rename(self.conn, "机器人", "智能机械", self.revision())
        self.assertEqual(self.tree()["机械"], "智能机械")
        tags.rename(self.conn, "机械", "仿生", self.revision(), True)
        self.assertEqual(self.tree()["人形"], "仿生")
        self.assertEqual(tags.members(self.conn, "智能机械")["count"], 2)
        preflight = tags.delete_tag(self.conn, "仿生", self.revision())
        self.assertEqual(preflight["children"], 1)
        tags.delete_tag(self.conn, "仿生", self.revision(), True)
        self.assertEqual(self.tree()["人形"], "智能机械")
        self.assertIn("人形", db.get_stock_tags(self.conn, "000001")["tags"])
        self.node("仿生")
        self.assertEqual(self.tree()["仿生"], "")
        self.assertEqual(tags.members(self.conn, "仿生")["count"], 0)
        self.assertEqual(self.tree()["人形"], "智能机械")

    def test_merge_cannot_create_indirect_cycle_and_rolls_back_aliases(self):
        self.setup_tree()
        before = (self.tree(), db.get_tag_aliases(self.conn), self.revision())
        with self.assertRaises(ValueError):
            tags.rename(self.conn, "机器人", "人形", self.revision(), True)
        self.assertEqual((self.tree(), db.get_tag_aliases(self.conn), self.revision()), before)

    def test_public_read_metadata_and_write_permissions(self):
        def request(payload, readonly=False):
            handler = object.__new__(app.Handler)
            handler.path, handler.server = "/api/tag-node", SimpleNamespace(db_path=":memory:", read_only=readonly)
            raw = json.dumps(payload).encode()
            handler.headers = {"Content-Type": "application/json", "Content-Length": str(len(raw))}
            handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
            result = {}
            handler.send_response = lambda status: result.update(status=status)
            handler.send_header = lambda *args: None
            handler.end_headers = lambda: None
            with patch.object(app.db, "connect", return_value=self.conn), patch.object(app, "closing", side_effect=nullcontext):
                handler.do_POST()
            return result["status"]
        payload = {"name": "机器人", "parent": "", "revision": self.revision()}
        self.assertEqual(request(payload, True), 403)
        self.assertEqual(request(payload), 200)
        self.assertEqual(request(payload), 409)
        self.node("人形", "机器人", "parent")
        with patch.object(app.db, "connect", return_value=self.conn), patch.object(app, "closing", side_effect=nullcontext):
            meta = app.read_api(SimpleNamespace(db_path=":memory:", read_only=True), "/api/meta")
        self.assertIn({"name": "人形", "parent": "机器人"}, meta["tag_hierarchy"])
        self.assertFalse(meta["capabilities"]["manage_tags"])


if __name__ == "__main__":
    unittest.main()
