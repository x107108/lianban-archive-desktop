"""Whole-archive tag operations, merge confirmation and optimistic conflicts."""
from contextlib import nullcontext
import io
import json
import sqlite3
from pathlib import Path
import sys
from types import SimpleNamespace
from urllib.parse import quote
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
import database as db
import tag_management as tags


class TagManagementTests(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        for day in ("2026-10-20", "2026-10-21"):
            db.save_day(self.conn, day, [
                {"code": "000001", "name": "测试甲", "boards": 1},
                {"code": "000002", "name": "测试乙", "boards": 2},
                {"code": "600003", "name": "测试丙", "boards": 1}], "synthetic")
        db.save_stock_tags(self.conn, "000001", ["人形机器人", "自定义"], 0)
        db.save_stock_tags(self.conn, "000002", ["机器人"], 0)
        self.defaults("000001", ["人形机器人", "机器人", "风电"])
        self.defaults("000002", ["机器人", "风电"])
        self.defaults("600003", ["风电"])
        db.set_settings(self.conn, default_tag_mode="concept_intersection")

    def tearDown(self):
        self.conn.close()

    def defaults(self, code, names):
        db.save_default_tags(self.conn, [{"code": code, "tags": names, "ths_tags": names,
            "cls_tags": names, "fetched_at": db.now_iso()}], "synthetic")

    def revision(self):
        return tags.catalog(self.conn)["revision"]

    def rename(self, source, target, merge=False):
        return tags.rename(self.conn, source, target, self.revision(), merge)

    def snapshot(self):
        return {table: [tuple(row) for row in self.conn.execute("SELECT * FROM " + table)]
                for table in ("stock_tag_overrides", "stock_default_tags", "events", "tag_aliases", "settings",
                              "stock_tag_exclusions", "stock_notes", "stock_blacklist", "deleted_tags",
                              "tag_nodes")}

    def test_catalog_counts_distinct_stocks_across_dates_and_effective_labels(self):
        data = tags.catalog(self.conn)
        self.assertEqual(data["stocks"], 3)
        self.assertEqual(data["total"], 4)
        self.assertEqual(data["tags"][0], {"name": "风电", "count": 3})
        self.assertEqual(dict((t["name"], t["count"]) for t in data["tags"])["人形机器人"], 1)
        members = tags.members(self.conn, "机器人")
        self.assertEqual([r["code"] for r in members["rows"]], ["000001", "000002"])
        self.assertEqual(members["revision"], data["revision"])
        self.assertEqual(members["rows"][0]["initials"], "CSJ")
        current = db.get_stock_tags(self.conn, "000001")
        db.save_stock_tags(self.conn, "000001", [t for t in current["tags"] if t != "风电"], current["revision"])
        self.assertEqual(tags.members(self.conn, "风电")["count"], 2)

    def test_add_stock_preserves_existing_tags_and_duplicate_does_not_write(self):
        before = db.get_stock_tags(self.conn, "600003")["tags"]
        result = tags.add_stock(self.conn, "自定义", "600003", self.revision())
        self.assertTrue(result["changed"])
        self.assertEqual(set(db.get_stock_tags(self.conn, "600003")["tags"]), set(before + ["自定义"]))
        self.assertEqual(tags.members(self.conn, "自定义")["count"], 2)
        revision = db.get_stock_tags(self.conn, "600003")["revision"]
        self.assertFalse(tags.add_stock(self.conn, "自定义", "600003", self.revision())["changed"])
        self.assertEqual(db.get_stock_tags(self.conn, "600003")["revision"], revision)

    def test_batch_add_deduplicates_preserves_tags_notes_and_blacklist(self):
        db.save_stock_note(self.conn, "600003", "个人备注", 0)
        db.save_blacklist(self.conn, "600003", "add")
        before = self.snapshot()
        revision = db.get_stock_tags(self.conn, "000001")["revision"]
        result = tags.add_stocks(self.conn, "自定义", ["000001", "600003", "600003"], self.revision())
        self.assertEqual((result["count"], result["added"], result["existing"]), (2, 1, 1))
        self.assertEqual(db.get_stock_tags(self.conn, "000001")["revision"], revision)
        self.assertCountEqual(db.get_stock_tags(self.conn, "600003")["tags"], ["风电", "自定义"])
        self.assertEqual(result["catalog"]["revision"], self.revision())
        for table in ("events", "stock_default_tags", "stock_notes", "stock_blacklist"):
            self.assertEqual(self.snapshot()[table], before[table])
        before_repeat = self.snapshot()
        repeated = tags.add_stocks(self.conn, "自定义", ["600003", "000001"], self.revision())
        self.assertEqual((repeated["added"], repeated["existing"]), (0, 2))
        self.assertEqual(self.snapshot(), before_repeat)

    def test_batch_add_is_atomic_for_unknown_stock_and_later_save_failure(self):
        before = self.snapshot()
        with self.assertRaises(ValueError):
            tags.add_stocks(self.conn, "自定义", ["000002", "999999"], self.revision())
        self.assertEqual(self.snapshot(), before)
        original, calls = db.save_stock_tags, []
        def failing_save(*args, **kwargs):
            calls.append(args[1])
            if len(calls) == 2:
                raise ValueError("模拟第二只股票无法保存")
            return original(*args, **kwargs)
        with patch.object(db, "save_stock_tags", side_effect=failing_save), self.assertRaises(ValueError):
            tags.add_stocks(self.conn, "自定义", ["000002", "600003"], self.revision())
        self.assertEqual(calls, ["000002", "600003"])
        self.assertEqual(self.snapshot(), before, "the first saved stock also rolls back")

    def test_batch_validation_conflicts_and_exclusions(self):
        for codes in (None, "600003", [], ["600003"] * 201, [123456], [True], ["１２３４５６"], ["60003"]):
            before = self.snapshot()
            with self.subTest(codes=codes), self.assertRaises(ValueError):
                tags.add_stocks(self.conn, "自定义", codes, self.revision())
            self.assertEqual(self.snapshot(), before)
        stale = self.revision()
        tags.remove_stock(self.conn, "风电", "000002", stale)
        before = self.snapshot()
        with self.assertRaises(db.TagConflictError):
            tags.add_stocks(self.conn, "自定义", ["600003"], stale)
        self.assertEqual(self.snapshot(), before)
        tags.add_stocks(self.conn, "自定义", ["000002", "600003"], self.revision())
        self.assertIn("自定义", db.get_stock_tags(self.conn, "000002")["tags"])
        self.assertNotIn("风电", db.get_stock_tags(self.conn, "000002")["tags"])
        self.defaults("000002", ["机器人", "风电"])
        self.assertNotIn("风电", db.get_stock_tags(self.conn, "000002")["tags"])

    def test_remove_custom_and_source_tags_preserves_other_tags_and_stocks(self):
        before_other = db.get_stock_tags(self.conn, "000002")
        before = db.get_stock_tags(self.conn, "000001")["tags"]
        tags.remove_stock(self.conn, "人形机器人", "000001", self.revision())
        current = db.get_stock_tags(self.conn, "000001")
        self.assertEqual(current["tags"], [tag for tag in before if tag != "人形机器人"])
        self.assertNotIn("人形机器人", current["custom_tags"])
        self.assertIn("人形机器人", current["excluded_tags"])
        self.assertEqual(db.get_stock_tags(self.conn, "000002"), before_other)
        self.defaults("000001", ["人形机器人", "机器人", "风电"])
        self.assertNotIn("人形机器人", db.get_stock_tags(self.conn, "000001")["tags"])
        tags.remove_stock(self.conn, "自定义", "000001", self.revision())
        self.assertNotIn("自定义", db.get_stock_tags(self.conn, "000001")["tags"])

    def test_remove_merged_label_suppresses_all_current_source_names_and_readd_works(self):
        self.rename("人形机器人", "机器人", True)
        tags.remove_stock(self.conn, "机器人", "000001", self.revision())
        current = db.get_stock_tags(self.conn, "000001")
        self.assertNotIn("机器人", current["tags"])
        self.assertEqual(set(current["excluded_tags"]), {"人形机器人", "机器人"})
        self.assertIn("自定义", current["tags"])
        self.assertIn("机器人", db.get_stock_tags(self.conn, "000002")["tags"])
        tags.add_stock(self.conn, "机器人", "000001", self.revision())
        self.assertEqual(db.get_stock_tags(self.conn, "000001")["tags"].count("机器人"), 1)

    def test_remove_last_stock_hides_unused_tag_and_stale_remove_is_atomic(self):
        revision = self.revision()
        tags.remove_stock(self.conn, "自定义", "000001", revision)
        self.assertNotIn("自定义", [tag["name"] for tag in tags.catalog(self.conn)["tags"]])
        before = self.snapshot()
        with self.assertRaises(db.TagConflictError):
            tags.remove_stock(self.conn, "风电", "000002", revision)
        with self.assertRaises(ValueError):
            tags.change_stock(self.conn, "风电", "000002", self.revision(), "invalid")
        self.assertEqual(self.snapshot(), before)

    def test_metadata_order_matches_whole_archive_catalog_and_changes_with_membership(self):
        meta = self.request("/api/meta")["body"]
        self.assertEqual(meta["tag_order"], [tag["name"] for tag in tags.catalog(self.conn)["tags"]])
        self.assertEqual(meta["tag_order"][0], "风电")
        tags.remove_stock(self.conn, "风电", "600003", self.revision())
        updated = self.request("/api/meta")["body"]
        self.assertNotEqual(updated["tag_catalog_revision"], meta["tag_catalog_revision"])
        self.assertEqual(updated["tag_order"][0], "机器人")

    def test_delete_requires_confirmation_and_preserves_all_other_stock_content(self):
        db.save_stock_note(self.conn, "000001", "保留备注", 0)
        db.save_blacklist(self.conn, "000001", "add")
        before = self.snapshot()
        old_tags = {code: db.get_stock_tags(self.conn, code)["tags"] for code in ("000001", "000002", "600003")}
        pending = tags.delete_tag(self.conn, "机器人", self.revision())
        self.assertEqual(pending["count"], 2)
        self.assertTrue(pending["needs_confirmation"])
        self.assertEqual(self.snapshot(), before, "opening or cancelling confirmation never deletes")
        result = tags.delete_tag(self.conn, pending["name"], pending["revision"], True)
        self.assertTrue(result["deleted"])
        for code, previous in old_tags.items():
            current = db.get_stock_tags(self.conn, code)
            self.assertEqual(current["tags"], [tag for tag in previous if tag != "机器人"])
            self.assertNotIn("机器人", current["custom_tags"])
            self.assertNotIn("机器人", current["source_tags"])
        for table in ("stock_default_tags", "events", "stock_notes", "stock_blacklist"):
            self.assertEqual(self.snapshot()[table], before[table], table)
        for table in ("stock_tag_overrides", "stock_tag_exclusions"):
            self.assertTrue(all("机器人" not in json.loads(row[0]) for row in self.conn.execute(
                "SELECT tags_json FROM " + table + " WHERE tags_json IS NOT NULL")))
        self.assertNotIn("机器人", self.request("/api/meta")["body"]["tag_order"])
        for row in db.date_view(self.conn, "2026-10-21")["rows"]:
            self.assertNotIn("机器人", row["tags"])
        self.assertNotIn("机器人", db.get_blacklist(self.conn)["rows"][0]["tags"])
        self.assertIn("人形机器人", db.get_stock_tags(self.conn, "000001")["tags"])

    def test_deleted_name_stays_hidden_but_previous_merged_name_is_independent(self):
        self.rename("人形机器人", "机器人", True)
        old_editor = db.get_stock_tags(self.conn, "000001")
        tags.delete_tag(self.conn, "机器人", self.revision(), True)
        self.defaults("600003", ["人形机器人", "机器人", "风电"])
        self.assertEqual(db.get_stock_tags(self.conn, "600003")["tags"], ["人形机器人", "风电"])
        current = db.get_stock_tags(self.conn, "000001")
        restored = db.save_stock_tags(self.conn, "000001", [], current["revision"], use_source=True)
        self.assertCountEqual(restored["tags"], ["人形机器人", "风电"])
        with self.assertRaises(db.TagConflictError):
            db.save_stock_tags(self.conn, "000002", old_editor["tags"], 1, alias_revision=old_editor["tag_alias_revision"])
        db.save_stock_tags(self.conn, "600003", ["人形机器人"], 0)
        db.save_stock_tags(self.conn, "600003", ["机器人"], 1)
        self.assertEqual([row["code"] for row in tags.members(self.conn, "机器人")["rows"]], ["600003"])
        self.assertCountEqual([tag["name"] for tag in tags.catalog(self.conn)["tags"]], ["人形机器人", "风电", "机器人"])

    def test_stale_delete_confirmation_and_invalid_requests_do_not_delete(self):
        pending = tags.delete_tag(self.conn, "机器人", self.revision())
        tags.add_stock(self.conn, "机器人", "600003", self.revision())
        before = self.snapshot()
        with self.assertRaises(db.TagConflictError):
            tags.delete_tag(self.conn, "机器人", pending["revision"], True)
        for confirm in (1, "yes", None):
            with self.subTest(confirm=confirm), self.assertRaises(ValueError):
                tags.delete_tag(self.conn, "机器人", self.revision(), confirm)
        with self.assertRaises(ValueError):
            tags.delete_tag(self.conn, "不存在", self.revision(), True)
        self.assertEqual(self.snapshot(), before)

    def test_delete_failure_rolls_back_the_global_marker_and_revision(self):
        db.set_settings(self.conn, tag_alias_revision=0)
        self.conn.execute("CREATE TRIGGER fail_global_tag_delete BEFORE UPDATE ON settings "
                          "WHEN OLD.key='tag_alias_revision' BEGIN SELECT RAISE(ABORT,'simulated failure'); END")
        self.conn.commit()
        before = self.snapshot()
        with self.assertRaises(sqlite3.IntegrityError):
            tags.delete_tag(self.conn, "机器人", self.revision(), True)
        self.assertEqual(self.snapshot(), before)

    def test_http_delete_preview_confirm_and_stale_conflict(self):
        args = {"tag": "机器人", "revision": self.revision()}
        preview = self.request("/api/tag-delete", "POST", args)
        self.assertEqual(preview["status"], 200)
        self.assertTrue(preview["body"]["needs_confirmation"])
        self.assertEqual(tags.members(self.conn, "机器人")["count"], 2)
        confirmed = self.request("/api/tag-delete", "POST", dict(args, confirm=True))
        self.assertTrue(confirmed["body"]["deleted"])
        self.assertEqual(self.request("/api/tag-delete", "POST", dict(args, confirm=True))["status"], 409)
        self.assertEqual(self.request("/api/tag-delete", "POST", dict(args, confirm="yes"))["status"], 400)

    def test_rename_updates_existing_labels_without_reserving_previous_name(self):
        before = self.snapshot()
        self.assertTrue(self.rename("人形机器人", "人形智能")["changed"])
        self.assertEqual(self.snapshot()["events"], before["events"])
        self.assertEqual(self.conn.execute("SELECT ths_tags_json FROM stock_default_tags WHERE code='000001'").fetchone()[0], '["人形机器人", "机器人", "风电"]')
        for day in ("2026-10-20", "2026-10-21"):
            stock = next(r for r in db.date_view(self.conn, day)["rows"] if r["code"] == "000001")
            self.assertIn("人形智能", stock["tags"])
            self.assertNotIn("人形机器人", stock["tags"])
        self.assertIn("人形智能", db.stock_view(self.conn, "000001", "2026-10-20", "2026-10-21")["stock"]["tags"])
        self.defaults("600003", ["人形机器人", "风电"])
        self.assertIn("人形机器人", db.get_stock_tags(self.conn, "600003")["tags"])
        self.assertNotIn("人形智能", db.get_stock_tags(self.conn, "600003")["tags"])
        self.assertEqual(tags.members(self.conn, "人形智能")["count"], 1)
        current = db.get_stock_tags(self.conn, "000001")
        saved = db.save_stock_tags(self.conn, "000001", current["tags"] + ["人形机器人"], current["revision"])
        self.assertIn("人形机器人", saved["tags"])
        self.assertIn("人形智能", saved["tags"], "the same stock may have both independent names")
        self.rename("人形智能", "机器人零部件")
        self.assertIn("人形机器人", db.get_stock_tags(self.conn, "000001")["tags"])
        self.assertNotIn("人形机器人", db.get_tag_aliases(self.conn))

    def test_same_name_requires_confirmation_then_deduplicates_memberships(self):
        before = self.snapshot()
        revision = self.revision()
        pending = tags.rename(self.conn, "人形机器人", "机器人", revision)
        self.assertTrue(pending["needs_merge"])
        self.assertEqual((pending["source_count"], pending["target_count"], pending["combined_count"]), (1, 2, 2))
        self.assertEqual(self.snapshot(), before, "preflight/cancel never changes data")
        result = tags.rename(self.conn, "人形机器人", "机器人", pending["revision"], True)
        self.assertFalse(result["needs_merge"])
        current = db.get_stock_tags(self.conn, "000001")["tags"]
        self.assertEqual(current.count("机器人"), 1)
        self.assertNotIn("人形机器人", current)
        self.assertEqual(tags.members(self.conn, "机器人")["count"], 2)
        self.assertEqual(tags.catalog(self.conn)["total"], 3)
        tags.save_node(self.conn, "人形机器人", "", self.revision())
        tags.add_stock(self.conn, "人形机器人", "600003", self.revision())
        self.assertEqual(tags.members(self.conn, "人形机器人")["count"], 1)
        self.assertEqual(tags.members(self.conn, "机器人")["count"], 2)

    def test_transitive_rename_rename_back_and_case_only_changes(self):
        self.rename("人形机器人", "测试概念")
        self.rename("测试概念", "新名字")
        self.rename("新名字", "人形机器人")
        self.assertIn("人形机器人", db.get_stock_tags(self.conn, "000001")["tags"])
        self.rename("人形机器人", "AI")
        self.rename("AI", "ai")
        self.assertIn("ai", db.get_stock_tags(self.conn, "000001")["tags"])
        self.assertNotIn("AI", db.get_stock_tags(self.conn, "000001")["tags"])

    def test_merging_excluded_default_does_not_hide_allowed_destination(self):
        # Keep Robot while suppressing Humanoid on stock three.
        self.defaults("600003", ["人形机器人", "机器人"])
        db.save_stock_tags(self.conn, "600003", ["机器人"], 0)
        self.rename("人形机器人", "机器人", True)
        self.assertEqual(db.get_stock_tags(self.conn, "600003")["tags"], ["机器人"])
        current = db.get_stock_tags(self.conn, "600003")
        db.save_stock_tags(self.conn, "600003", [], current["revision"], alias_revision=current["tag_alias_revision"])
        self.assertEqual(db.get_stock_tags(self.conn, "600003")["tags"], [])
        hidden = db.get_stock_tags(self.conn, "600003")["excluded_tags"]
        self.assertEqual(set(hidden), {"人形机器人", "机器人"})
        tags.add_stock(self.conn, "机器人", "600003", self.revision())
        self.assertEqual(db.get_stock_tags(self.conn, "600003")["tags"], ["机器人"])

    def test_stale_catalog_and_open_stock_editor_cannot_overwrite_global_changes(self):
        revision = self.revision()
        editor = db.get_stock_tags(self.conn, "000001")
        self.rename("人形机器人", "新概念")
        before = self.snapshot()
        with self.assertRaises(db.TagConflictError):
            tags.add_stock(self.conn, "机器人", "600003", revision)
        with self.assertRaises(db.TagConflictError):
            tags.rename(self.conn, "风电", "别名", revision)
        with self.assertRaises(db.TagConflictError):
            db.save_stock_tags(self.conn, "000001", editor["tags"], editor["revision"], alias_revision=editor["tag_alias_revision"])
        self.assertEqual(self.snapshot(), before)

    def test_confirmation_rechecks_data_and_unknown_names_or_stocks_are_atomic(self):
        pending = self.rename("人形机器人", "机器人")
        tags.add_stock(self.conn, "机器人", "600003", self.revision())
        with self.assertRaises(db.TagConflictError):
            tags.rename(self.conn, pending["source"], pending["target"], pending["revision"], True)
        before = self.snapshot()
        for name in ("", None, "x" * 31, "bad\nname"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                tags.rename(self.conn, "风电", name, self.revision())
        for name, code in (("没有", "600003"), ("机器人", "999999"), ("机器人", "bad")):
            with self.assertRaises(ValueError):
                tags.add_stock(self.conn, name, code, self.revision())
        self.assertEqual(self.snapshot(), before)

    def request(self, path, method="GET", payload=None, read_only=False):
        handler = object.__new__(app.Handler)
        handler.path = path
        handler.server = SimpleNamespace(db_path=":memory:", read_only=read_only)
        body = json.dumps(payload).encode("utf-8")
        handler.headers = {"Content-Type": "application/json", "Content-Length": str(len(body))}
        handler.rfile, handler.wfile = io.BytesIO(body), io.BytesIO()
        result = {}
        handler.send_response = lambda status: result.update(status=status)
        handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        with patch.object(app.db, "connect", return_value=self.conn), patch.object(app, "closing", side_effect=nullcontext):
            getattr(handler, "do_" + method)()
        result["body"] = json.loads(handler.wfile.getvalue())
        return result

    def test_http_catalog_assign_rename_preflight_confirm_and_conflict(self):
        catalog = self.request("/api/tags")
        self.assertEqual(catalog["status"], 200)
        revision = catalog["body"]["revision"]
        self.assertEqual(self.request("/api/tag-stocks?tag=" + quote("机器人"))["body"]["count"], 2)
        args = {"source": "人形机器人", "target": "机器人", "revision": revision}
        preflight = self.request("/api/tag-rename", "POST", args)
        self.assertTrue(preflight["body"]["needs_merge"])
        self.assertEqual(self.request("/api/tag-rename", "POST", dict(args, merge=True))["status"], 200)
        self.assertEqual(self.request("/api/tag-rename", "POST", args)["status"], 409)
        self.assertEqual(self.request("/api/tag-stocks", "POST", {"tag": "机器人", "code": "600003", "revision": self.revision()})["status"], 200)
        self.assertEqual(self.request("/api/tag-rename", "POST", ["bad"])["status"], 400)
        remove = self.request("/api/tag-stocks", "POST", {"tag": "机器人", "code": "600003", "revision": self.revision(), "action": "remove"})
        self.assertEqual(remove["status"], 200)
        self.assertTrue(remove["body"]["changed"])
        self.assertNotIn("机器人", db.get_stock_tags(self.conn, "600003")["tags"])

    def test_http_batch_add_validation_conflict_and_readonly(self):
        payload = {"tag": "自定义", "codes": ["000002", "600003", "600003"], "revision": self.revision()}
        before = self.snapshot()
        self.assertEqual(self.request("/api/tag-stocks", "POST", payload, read_only=True)["status"], 403)
        self.assertEqual(self.snapshot(), before)
        response = self.request("/api/tag-stocks", "POST", payload)
        self.assertEqual(response["status"], 200)
        self.assertEqual((response["body"]["count"], response["body"]["added"]), (2, 2))
        self.assertEqual(self.request("/api/tag-stocks", "POST", payload)["status"], 409)
        for invalid in (dict(payload, codes=None), dict(payload, action="remove")):
            self.assertEqual(self.request("/api/tag-stocks", "POST", invalid)["status"], 400)


if __name__ == "__main__":
    unittest.main()
