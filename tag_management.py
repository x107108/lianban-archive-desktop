"""Whole-archive tag inventory, stock assignment and independent tag names."""
from __future__ import annotations

import hashlib
import json
import re

import database as db


def tag_name(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 30 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("标签名称需为 1 至 30 个字符")
    return value.strip()


def hierarchy(conn):
    aliases = db.get_tag_aliases(conn)
    records = list(conn.execute("SELECT * FROM tag_nodes ORDER BY tag_key"))
    records.sort(key=lambda row: row["tag_key"] != aliases.get(row["tag_key"], row["name"]).casefold())
    nodes = {}
    for row in records:
        name = aliases.get(row["tag_key"], row["name"])
        parent = aliases.get(row["parent_key"], row["parent_key"] or "")
        if parent.casefold() == name.casefold():
            parent = ""
        nodes.setdefault(name.casefold(), {"name": name, "parent": parent})
    for node in nodes.values():
        node["parent"] = nodes.get(node["parent"].casefold(), {}).get("name", node["parent"])
    return sorted(nodes.values(), key=lambda node: node["name"].casefold())


def _validate_hierarchy(nodes):
    parents = {node["name"].casefold(): node["parent"].casefold() for node in nodes}
    for key in parents:
        seen, current = set(), key
        while current:
            if current in seen:
                raise ValueError("父子标签不能形成循环，请选择其他父级")
            seen.add(current)
            current = parents.get(current, "")


def _save_hierarchy(conn, nodes):
    _validate_hierarchy(nodes)
    conn.execute("DELETE FROM tag_nodes")
    conn.executemany("INSERT INTO tag_nodes VALUES (?,?,?)", [(node["name"].casefold(), node["name"], node["parent"].casefold() or None) for node in nodes])


def _bump_revision(conn):
    conn.execute("INSERT INTO settings VALUES ('tag_alias_revision','1') ON CONFLICT(key) "
                 "DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)")


def migrate_detached_names(conn):
    """Preserve old rename results, then release every non-identical old name."""
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        if conn.execute("SELECT 1 FROM settings WHERE key='tag_name_storage'").fetchone():
            return
        aliases = db.get_tag_aliases(conn)
        if aliases:
            # Released aliases of deleted tags must stay suppressed in provider
            # defaults, even after their names become independently reusable.
            deleted = db.get_deleted_tag_keys(conn)
            conn.executemany("INSERT OR IGNORE INTO deleted_tags VALUES (?,?,?)",
                             [(key, key, db.now_iso()) for key, name in aliases.items() if name.casefold() in deleted])
            nodes = hierarchy(conn)
            db.rewrite_tag_names(conn, aliases)
            _save_hierarchy(conn, nodes)
            conn.execute("DELETE FROM tag_aliases")
            conn.executemany("INSERT INTO tag_aliases VALUES (?,?)", {(name.casefold(), name) for name in aliases.values()})
            _bump_revision(conn)
        conn.execute("INSERT INTO settings VALUES ('tag_name_storage','\"detached-v1\"')")


def migrate_deleted_names(conn):
    """Clear legacy deleted assignments once, while allowing independent name reuse."""
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        if conn.execute("SELECT 1 FROM settings WHERE key='tag_deletion_storage'").fetchone():
            return
        deleted = db.get_deleted_tag_keys(conn)
        if deleted:
            nodes = hierarchy(conn)
            db.remove_tag_assignments(conn, deleted)
            _save_hierarchy(conn, [{**node, "parent": "" if node["parent"].casefold() in deleted else node["parent"]}
                                   for node in nodes if node["name"].casefold() not in deleted])
            _bump_revision(conn)
        conn.execute("INSERT INTO settings VALUES ('tag_deletion_storage','\"reusable-v1\"')")


def descendants(nodes, name):
    keys = {name.casefold()}
    while True:
        expanded = keys | {node["name"].casefold() for node in nodes if node["parent"].casefold() in keys}
        if expanded == keys:
            return keys
        keys = expanded


def _inventory(conn):
    rows = [dict(row) for row in conn.execute("SELECT code,name,market FROM stocks ORDER BY code")]
    for offset in range(0, len(rows), 500):
        db.enrich_industries(conn, rows[offset:offset + 500])
    groups = {}
    for stock in rows:
        for name in stock["tags"]:
            key = name.casefold()
            group = groups.setdefault(key, {"name": name, "rows": []})
            group["rows"].append(stock)
    nodes = hierarchy(conn)
    for node in nodes:
        groups.setdefault(node["name"].casefold(), {"name": node["name"], "rows": []})
    signature = json.dumps([db.tag_alias_revision(conn), nodes, [(r["code"], r["tags"]) for r in rows]], ensure_ascii=False, separators=(",", ":"))
    return groups, hashlib.sha256(signature.encode("utf-8")).hexdigest()


def catalog(conn):
    groups, revision = _inventory(conn)
    nodes = hierarchy(conn)
    tags = sorted(({"name": group["name"], "count": len({r["code"] for key in descendants(nodes, group["name"]) for r in groups.get(key, {}).get("rows", [])})} for group in groups.values()),
                  key=lambda tag: (-tag["count"], tag["name"].casefold()))
    return {"tags": tags, "total": len(tags), "stocks": len({r["code"] for group in groups.values() for r in group["rows"]}), "revision": revision,
            "hierarchy": nodes, "direct_counts": {group["name"]: len(group["rows"]) for group in groups.values()}}


def members(conn, name):
    name = tag_name(name)
    groups, revision = _inventory(conn)
    group = groups.get(name.casefold())
    if group is None:
        raise ValueError("这个标签已不存在，请刷新标签列表")
    keys = descendants(hierarchy(conn), group["name"])
    union = {r["code"]: r for key in keys for r in groups.get(key, {}).get("rows", [])}
    direct = {r["code"] for r in group["rows"]}
    rows = [{"code": r["code"], "name": r["name"], "initials": db.stock_initials(r["name"]), "direct": r["code"] in direct,
             "registered_province": r.get("registered_province", "")} for _, r in sorted(union.items())]
    return {"name": group["name"], "rows": rows, "count": len(rows), "direct_count": len(direct), "revision": revision}


def save_node(conn, name, parent, revision, action="create"):
    name = tag_name(name)
    parent = tag_name(parent) if parent not in (None, "") else ""
    if action not in ("create", "parent", "child"):
        raise ValueError("标签层级操作无效")
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        groups, actual = _inventory(conn)
        _check_revision(actual, revision)
        group = groups.get(name.casefold())
        if action == "create" and group:
            raise ValueError("已有同名标签，请选择该标签后设置父级")
        if action == "parent" and group is None:
            raise ValueError("标签已不存在，请刷新列表")
        if action == "child" and not parent:
            raise ValueError("请选择父级标签")
        if group:
            name = group["name"]
        else:
            canonical = db.get_tag_aliases(conn).get(name.casefold(), name)
            if canonical.casefold() != name.casefold():
                raise ValueError("该名称已合并，请使用其他名称")
        if parent:
            target = groups.get(parent.casefold())
            if not target:
                raise ValueError("父级标签已不存在，请刷新列表")
            parent = target["name"]
            if parent.casefold() == name.casefold():
                raise ValueError("标签不能成为自己的父级")
        nodes = {node["name"].casefold(): node for node in hierarchy(conn)}
        nodes[name.casefold()] = {"name": name, "parent": parent}
        if parent:
            nodes.setdefault(parent.casefold(), {"name": parent, "parent": ""})
        _save_hierarchy(conn, list(nodes.values()))
        if not group:
            conn.execute("INSERT INTO tag_aliases VALUES (?,?) ON CONFLICT(tag_key) DO UPDATE SET name=excluded.name", (name.casefold(), name))
        _bump_revision(conn)
        return {"name": name, "parent": parent, "catalog": catalog(conn)}


def _check_revision(actual, expected):
    if not isinstance(expected, str) or actual != expected:
        raise db.TagConflictError("标签或所属股票已发生变化，请刷新列表后重试")


def save_stock_tag_paths(conn, code, labels, revision, use_source=False, alias_revision=None):
    """Save slash-separated hierarchy drafts and stock memberships together."""
    if not isinstance(labels, list) or not any(isinstance(label, str) and "/" in label for label in labels):
        return db.save_stock_tags(conn, code, labels, revision, use_source, alias_revision)
    paths = [[tag_name(part) for part in label.split("/")] if isinstance(label, str) else [tag_name(label)] for label in labels]
    if use_source:
        raise ValueError("恢复默认标签时不能同时新建子标签")
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        groups, _ = _inventory(conn)
        nodes = {node["name"].casefold(): node for node in hierarchy(conn)}
        original = dict(nodes)
        selected = []
        for path in paths:
            parent = ""
            for index, entered in enumerate(path):
                key = entered.casefold()
                existing = nodes.get(key) or groups.get(key)
                name = existing["name"] if existing else entered
                if index and existing and nodes.get(key, {}).get("parent", "").casefold() != parent.casefold():
                    raise ValueError(f"“{name}”已存在于其他位置，请在标签管理中修改父级")
                if len(path) > 1:
                    if index or not existing:
                        nodes[key] = {"name": name, "parent": parent}
                    else:
                        nodes.setdefault(key, {"name": name, "parent": ""})
                parent = name
            selected.append(parent)
        _validate_hierarchy(list(nodes.values()))
        db.save_stock_tags(conn, code, selected, revision, use_source, alias_revision, _commit=False)
        if nodes != original:
            _save_hierarchy(conn, list(nodes.values()))
            conn.executemany("INSERT INTO tag_aliases VALUES (?,?) ON CONFLICT(tag_key) DO UPDATE SET name=excluded.name",
                             [(key, node["name"]) for key, node in nodes.items() if key not in original])
            _bump_revision(conn)
        return db.get_stock_tags(conn, code)


def rename(conn, source, target, revision, merge=False):
    source, target = tag_name(source), tag_name(target)
    if type(merge) is not bool:
        raise ValueError("合并选项无效")
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        groups, actual = _inventory(conn)
        _check_revision(actual, revision)
        origin = groups.get(source.casefold())
        if origin is None:
            raise ValueError("原标签已不存在，请刷新列表")
        source = origin["name"]
        destination = groups.get(target.casefold())
        if destination and source.casefold() != target.casefold() and not merge:
            return {"needs_merge": True, "source": source, "target": destination["name"],
                    "source_count": len(origin["rows"]), "target_count": len(destination["rows"]),
                    "combined_count": len({r["code"] for r in origin["rows"] + destination["rows"]}), "revision": actual}
        if destination and destination is not origin:
            target = destination["name"]
        aliases = db.get_tag_aliases(conn)
        previous_target = aliases.get(target.casefold(), target)
        if previous_target.casefold() not in (source.casefold(), target.casefold()):
            raise ValueError(f"该名称已合并到“{previous_target}”，请使用该标签名称")
        if source != target:
            # Canonicalize the graph transactionally, but never retain source
            # as an alias: users can immediately create that name independently.
            conn.execute("INSERT INTO tag_aliases VALUES (?,?) ON CONFLICT(tag_key) DO UPDATE SET name=excluded.name", (source.casefold(), target))
            nodes = hierarchy(conn)
            _validate_hierarchy(nodes)
            db.rewrite_tag_names(conn, {source.casefold(): target})
            _save_hierarchy(conn, nodes)
            conn.execute("DELETE FROM tag_aliases WHERE tag_key=?", (source.casefold(),))
            conn.execute("INSERT INTO tag_aliases VALUES (?,?) ON CONFLICT(tag_key) DO UPDATE SET name=excluded.name", (target.casefold(), target))
            _bump_revision(conn)
        return {"needs_merge": False, "name": target, "changed": source != target}


def change_stock(conn, name, code, revision, action="add"):
    name = tag_name(name)
    if action not in ("add", "remove"):
        raise ValueError("标签操作应为添加或移除")
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请选择一只六位代码的股票")
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        groups, actual = _inventory(conn)
        _check_revision(actual, revision)
        group = groups.get(name.casefold())
        if group is None:
            raise ValueError("这个标签已不存在，请刷新列表")
        name = group["name"]
        current = db.get_stock_tags(conn, code)
        present = name.casefold() in {tag.casefold() for tag in current["tags"]}
        changed = not present if action == "add" else present
        if changed:
            updated = current["tags"] + [name] if action == "add" else [tag for tag in current["tags"] if tag.casefold() != name.casefold()]
            db.save_stock_tags(conn, code, updated, current["revision"], alias_revision=current["tag_alias_revision"])
        return {"name": name, "code": code, "action": action, "changed": changed}


def add_stock(conn, name, code, revision):
    return change_stock(conn, name, code, revision, "add")


def add_stocks(conn, name, codes, revision):
    name = tag_name(name)
    if not isinstance(codes, list) or not 1 <= len(codes) <= 200:
        raise ValueError("每批请添加 1 至 200 只股票")
    if any(not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code) for code in codes):
        raise ValueError("请选择有效的六位股票代码")
    codes = list(dict.fromkeys(codes))
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        groups, actual = _inventory(conn)
        _check_revision(actual, revision)
        group = groups.get(name.casefold())
        if group is None:
            raise ValueError("这个标签已不存在，请刷新列表")
        name, results = group["name"], []
        for code in codes:
            current = db.get_stock_tags(conn, code)
            changed = name.casefold() not in {tag.casefold() for tag in current["tags"]}
            if changed:
                db.save_stock_tags(conn, code, current["tags"] + [name], current["revision"],
                                   alias_revision=current["tag_alias_revision"], _commit=False)
            results.append({"code": code, "name": current["name"], "changed": changed})
        added = sum(row["changed"] for row in results)
        return {"name": name, "count": len(results), "added": added, "existing": len(results) - added,
                "rows": results, "catalog": catalog(conn)}


def remove_stock(conn, name, code, revision):
    return change_stock(conn, name, code, revision, "remove")


def delete_tag(conn, name, revision, confirm=False):
    name = tag_name(name)
    if type(confirm) is not bool:
        raise ValueError("删除确认选项无效")
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        groups, actual = _inventory(conn)
        _check_revision(actual, revision)
        group = groups.get(name.casefold())
        if group is None:
            raise ValueError("这个标签已不存在，请刷新列表")
        name, count = group["name"], len(group["rows"])
        nodes = hierarchy(conn)
        children = [node for node in nodes if node["parent"].casefold() == name.casefold()]
        if not confirm:
            return {"needs_confirmation": True, "name": name, "count": count, "revision": actual, "children": len(children)}
        # Source suppression prevents provider refreshes from reviving old members;
        # personal assignments and name aliases are cleared, so reuse starts fresh.
        conn.execute("INSERT INTO deleted_tags VALUES (?,?,?) ON CONFLICT(tag_key) DO UPDATE SET name=excluded.name,deleted_at=excluded.deleted_at",
                     (name.casefold(), name, db.now_iso()))
        db.remove_tag_assignments(conn, {name.casefold()})
        parent = next((node["parent"] for node in nodes if node["name"].casefold() == name.casefold()), "")
        _save_hierarchy(conn, [{**node, "parent": parent if node in children else node["parent"]} for node in nodes if node["name"].casefold() != name.casefold()])
        _bump_revision(conn)
        return {"needs_confirmation": False, "name": name, "count": count, "deleted": True}
