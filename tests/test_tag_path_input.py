"""Slash drafts create real hierarchy nodes atomically with stock assignments."""
from contextlib import nullcontext
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
import database as db
import tag_management as tags


class TagPathInputTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.save_day(self.conn, "2026-10-28", [{"code": "000001", "name": "样本", "boards": 1}], "synthetic")
        db.save_stock_tags(self.conn, "000001", ["原有"], 0)
        tags.save_node(self.conn, "机器人", "", tags.catalog(self.conn)["revision"])

    def tearDown(self):
        self.conn.close()

    def save(self, labels, **options):
        current = db.get_stock_tags(self.conn, "000001")
        return tags.save_stock_tag_paths(self.conn, "000001", labels,
                                         options.get("revision", current["revision"]),
                                         options.get("use_source", False),
                                         options.get("alias_revision", current["tag_alias_revision"]))

    def tree(self):
        return {node["name"]: node["parent"] for node in tags.hierarchy(self.conn)}

    def test_new_child_existing_child_and_new_chain(self):
        result = self.save(["原有", " 机器人 / 电机 "])
        self.assertEqual(result["tags"], ["原有", "电机"])
        self.assertNotIn("机器人", result["tags"], "parent membership remains independent")
        self.assertEqual(self.tree()["电机"], "机器人")
        revision = result["tag_alias_revision"]
        self.assertEqual(self.save(["原有", "机器人/电机"])["tag_alias_revision"], revision)
        result = self.save(["原有", "新父级/新子级/新末级"])
        self.assertEqual(result["tags"], ["原有", "新末级"])
        self.assertEqual(self.tree()["新子级"], "新父级")
        self.assertEqual(self.tree()["新末级"], "新子级")
        self.assertEqual(tags.members(self.conn, "新父级")["count"], 1)
        self.assertFalse(tags.members(self.conn, "新父级")["rows"][0]["direct"])
        self.assertFalse(any("/" in tag["name"] for tag in tags.catalog(self.conn)["tags"]))

    def test_case_and_reused_names_are_independent(self):
        self.save(["机器人/Motor"])
        self.assertEqual(self.save(["机器人/motor"])["tags"], ["Motor"])
        tags.rename(self.conn, "Motor", "机器人零部件", tags.catalog(self.conn)["revision"])
        self.assertEqual(self.save(["机器人/Motor"])["tags"], ["Motor"])
        self.assertEqual(self.tree()["机器人零部件"], "机器人")
        self.assertEqual(self.tree()["Motor"], "机器人")

    def test_invalid_or_conflicting_paths_roll_back_everything(self):
        self.save(["机器人/电机"])
        before = (self.tree(), db.get_stock_tags(self.conn, "000001"), db.get_tag_aliases(self.conn))
        for labels, options in [(["新父/新子", "其他父/电机"], {}),
                                (["机器人/"], {}), (["/电机"], {}), (["机器人//电机"], {}),
                                (["机器人/" + "长" * 31], {}), (["机器人/坏\n标签"], {}),
                                (["机器人/机器人"], {}), (["新父/新子"], {"revision": 0}),
                                (["新父/新子"], {"alias_revision": 0}),
                                (["新父/新子"], {"use_source": True})]:
            with self.subTest(labels=labels, options=options), self.assertRaises(ValueError):
                self.save(labels, **options)
            self.assertEqual((self.tree(), db.get_stock_tags(self.conn, "000001"), db.get_tag_aliases(self.conn)), before)
        tags.delete_tag(self.conn, "电机", tags.catalog(self.conn)["revision"], True)
        self.assertEqual(self.save(["机器人/电机"])["tags"], ["电机"])
        self.assertEqual(self.tree()["电机"], "机器人")

    def test_source_labels_notes_and_blacklist_survive(self):
        self.conn.execute("INSERT INTO stock_default_tags VALUES (?,?,?,?,?,?)",
                          ("000001", '["默认概念"]', '[]', '[]', "synthetic", "2026-10-28"))
        self.conn.commit()
        db.save_stock_note(self.conn, "000001", "我的备注", 0)
        db.save_blacklist(self.conn, "000001", "add")
        original_source = tuple(self.conn.execute("SELECT * FROM stock_default_tags").fetchone())
        self.assertCountEqual(self.save(["原有", "默认概念", "机器人/电机"])["tags"], ["原有", "电机", "默认概念"])
        self.assertEqual(tuple(self.conn.execute("SELECT * FROM stock_default_tags").fetchone()), original_source)
        self.assertEqual(db.get_stock_note(self.conn, "000001")["content"], "我的备注")
        self.assertTrue(db.get_stock_tags(self.conn, "000001")["blacklisted"])

    def test_api_saves_hierarchy_and_read_only_rejects(self):
        def request(read_only):
            handler = object.__new__(app.Handler)
            handler.path = "/api/stock-tags"
            handler.server = SimpleNamespace(db_path=":memory:", read_only=read_only)
            current = db.get_stock_tags(self.conn, "000001")
            raw = json.dumps({"code": "000001", "tags": ["机器人/电机"], "revision": current["revision"],
                              "tag_alias_revision": current["tag_alias_revision"]}).encode()
            handler.headers = {"Content-Type": "application/json", "Content-Length": str(len(raw))}
            handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
            result = {}
            handler.send_response = lambda status: result.update(status=status)
            handler.send_header = lambda *args: None
            handler.end_headers = lambda: None
            with patch.object(app.db, "connect", return_value=self.conn), patch.object(app, "closing", side_effect=nullcontext):
                handler.do_POST()
            return result["status"]
        self.assertEqual(request(True), 403)
        self.assertNotIn("电机", self.tree())
        self.assertEqual(request(False), 200)
        self.assertEqual(self.tree()["电机"], "机器人")


if __name__ == "__main__":
    unittest.main()
