"""Local archive. Only source-provided, date-checked records enter this database."""
from __future__ import annotations

import json
import math
import re
import sqlite3
import unicodedata
from collections import Counter
from contextlib import nullcontext
from decimal import Decimal, InvalidOperation
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from functools import lru_cache
from urllib.parse import urlsplit

from pypinyin import Style, lazy_pinyin

from relationships import stock_relationships, stock_pair_comparison
from provinces import normalize_province

ROOT = Path(__file__).resolve().parent
DEFAULT_DB = ROOT / "data" / "archive.sqlite3"
REQUEST_START = "2020-01-01"
REQUEST_END = "2026-10-14"
TZ = timezone(timedelta(hours=8))
NOTE_DATE_UNSET = object()


def now_iso():
    return datetime.now(TZ).isoformat(timespec="seconds")


def connect(path=DEFAULT_DB):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS days (
            date TEXT PRIMARY KEY, status TEXT NOT NULL, source TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0,
            fetched_at TEXT NOT NULL, raw_path TEXT
        );
        CREATE TABLE IF NOT EXISTS live_pools (
            date TEXT PRIMARY KEY, records_json TEXT NOT NULL, source TEXT NOT NULL,
            fetched_at TEXT NOT NULL, raw_path TEXT, note TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS stocks (
            code TEXT PRIMARY KEY, name TEXT NOT NULL, market TEXT NOT NULL,
            last_seen TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            date TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
            market TEXT NOT NULL, industry TEXT, boards INTEGER NOT NULL,
            close REAL, pct_change REAL, turnover REAL,
            first_time TEXT, last_time TEXT, open_times INTEGER,
            limit_up_reason TEXT, source TEXT NOT NULL,
            PRIMARY KEY (date, code)
        );
        CREATE INDEX IF NOT EXISTS events_code_date ON events(code, date);
        CREATE TABLE IF NOT EXISTS stock_industries (
            code TEXT PRIMARY KEY, industry TEXT NOT NULL,
            industry_level2 TEXT NOT NULL, industry_level3 TEXT NOT NULL,
            industry_code TEXT NOT NULL, effective_from TEXT NOT NULL,
            source_updated_at TEXT NOT NULL, source TEXT NOT NULL, fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS company_registrations (
            code TEXT PRIMARY KEY, province TEXT NOT NULL, city TEXT NOT NULL,
            location TEXT NOT NULL, address TEXT NOT NULL,
            source TEXT NOT NULL, fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS shareholder_profiles (
            code TEXT NOT NULL, scope TEXT NOT NULL, report_date TEXT,
            source TEXT NOT NULL, fetched_at TEXT NOT NULL,
            PRIMARY KEY(code,scope)
        );
        CREATE TABLE IF NOT EXISTS stock_shareholders (
            code TEXT NOT NULL, scope TEXT NOT NULL, holder_key TEXT NOT NULL,
            holder_name TEXT NOT NULL, holder_type TEXT NOT NULL, report_date TEXT NOT NULL,
            PRIMARY KEY(code,scope,holder_key)
        );
        CREATE INDEX IF NOT EXISTS shareholders_holder ON stock_shareholders(holder_key,code);
        CREATE TABLE IF NOT EXISTS stock_tag_overrides (
            code TEXT PRIMARY KEY, tags_json TEXT, revision INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_tag_exclusions (
            code TEXT PRIMARY KEY, tags_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tag_aliases (
            tag_key TEXT PRIMARY KEY, name TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tag_nodes (
            tag_key TEXT PRIMARY KEY, name TEXT NOT NULL, parent_key TEXT
        );
        CREATE TABLE IF NOT EXISTS deleted_tags (
            tag_key TEXT PRIMARY KEY, name TEXT NOT NULL, deleted_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_default_tags (
            code TEXT PRIMARY KEY, tags_json TEXT NOT NULL,
            ths_tags_json TEXT NOT NULL, cls_tags_json TEXT NOT NULL,
            source TEXT NOT NULL, fetched_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_notes (
            code TEXT PRIMARY KEY, content TEXT NOT NULL, revision INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS stock_note_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL,
            occurred_at TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS stock_note_entries_code_time ON stock_note_entries(code,occurred_at DESC,id DESC);
        CREATE TABLE IF NOT EXISTS stock_note_options (
            entry_id INTEGER PRIMARY KEY, note_date TEXT, deleted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS stock_blacklist (
            code TEXT PRIMARY KEY, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS suspension_days (
            date TEXT PRIMARY KEY, status TEXT NOT NULL, checked_at TEXT NOT NULL,
            fetched_at TEXT, source TEXT, raw_paths TEXT, error TEXT
        );
        CREATE TABLE IF NOT EXISTS suspension_records (
            date TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
            start TEXT NOT NULL, end TEXT, resume TEXT, reason TEXT NOT NULL,
            full_day INTEGER NOT NULL, PRIMARY KEY(date,code)
        );
    """)
    if conn.execute("SELECT 1 FROM settings WHERE key='stock_note_history'").fetchone() is None:
        with conn:
            conn.execute("INSERT INTO stock_note_entries(code,occurred_at,content,updated_at) "
                         "SELECT n.code,n.updated_at,n.content,n.updated_at FROM stock_notes n "
                         "WHERE trim(n.content)<>'' AND NOT EXISTS (SELECT 1 FROM stock_note_entries e WHERE e.code=n.code)")
            conn.execute("INSERT OR IGNORE INTO settings VALUES ('stock_note_history','1')")
    if conn.execute("SELECT value FROM settings WHERE key='registration_storage'").fetchone() is None:
        conn.execute("PRAGMA secure_delete=ON")
        with conn:
            registrations = conn.execute("SELECT code,province FROM company_registrations").fetchall()
            conn.executemany("UPDATE company_registrations SET province=?,city='',location='',address='' WHERE code=?",
                             [(normalize_province(row["province"]), row["code"]) for row in registrations])
            conn.execute("UPDATE settings SET value='[]' WHERE key='registration_raw_paths'")
            conn.execute("INSERT OR IGNORE INTO settings VALUES ('registration_storage','\"province-only-v1\"')")
    if conn.execute("SELECT 1 FROM settings WHERE key='tag_name_storage'").fetchone() is None:
        from tag_management import migrate_detached_names
        migrate_detached_names(conn)
    return conn


def set_settings(conn, **values):
    with conn:
        for key, value in values.items():
            conn.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (key, json.dumps(value, ensure_ascii=False)))


def get_settings(conn):
    values = {r["key"]: json.loads(r["value"]) for r in conn.execute("SELECT * FROM settings")}
    values.setdefault("range_start", REQUEST_START)
    values.setdefault("range_end", REQUEST_END)
    values.setdefault("source", "免费公开涨停池")
    values.setdefault("scope_note", "数据范围以来源覆盖为准；未收录不等于未涨停。")
    values.setdefault("method_note", "连板数采用数据源字段；首板为 1。盘中触板不计为收盘涨停。")
    return values


DEFAULT_SITE_LINKS = {"author_url": "https://www.tgb.cn/blog/5894557", "feedback_url": ""}


def public_site_link(value):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\x7f\\]", value):
        return ""
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            return ""
        parsed.port  # Reject malformed ports before publishing a link.
    except ValueError:
        return ""
    return value


def get_site_links(conn):
    row = conn.execute("SELECT value FROM settings WHERE key='site_links'").fetchone()
    try:
        links = json.loads(row["value"]) if row else {}
    except (TypeError, json.JSONDecodeError):
        links = {}
    if not isinstance(links, dict):
        links = {}
    return {"links": {key: public_site_link(links.get(key, default)) for key, default in DEFAULT_SITE_LINKS.items()}}


def get_announcement(conn):
    """Public display fields only; disabled drafts never leave the database."""
    row = conn.execute("SELECT value FROM settings WHERE key='site_announcement'").fetchone()
    try:
        notice = json.loads(row["value"]) if row else {}
    except (TypeError, json.JSONDecodeError):
        notice = {}
    if not isinstance(notice, dict):
        notice = {}
    content = notice.get("content")
    enabled = notice.get("enabled") is True and isinstance(content, str) and bool(content.strip())
    title = notice.get("title")
    revision = notice.get("revision")
    updated_at = notice.get("updated_at")
    return {"announcement": {"title": title[:120] if enabled and isinstance(title, str) else "",
                             "content": content[:20000] if enabled else "", "enabled": enabled,
                             "revision": revision if type(revision) is int and revision >= 0 else 0,
                             "updated_at": updated_at[:64] if isinstance(updated_at, str) else None}}


def bump_suspension_revision(conn):
    conn.execute("INSERT INTO settings VALUES ('suspension_revision','1') ON CONFLICT(key) "
                 "DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)")


def save_suspensions(conn, day, records, source, raw_paths):
    now = now_iso()
    with conn:
        conn.execute("DELETE FROM suspension_records WHERE date=?", (day,))
        for row in records:
            conn.execute("INSERT INTO suspension_records VALUES (?,?,?,?,?,?,?,?)",
                         (day, row["code"], row["name"], row["start"], row["end"], row["resume"], row["reason"], int(row["full_day"])))
        conn.execute("INSERT INTO suspension_days VALUES (?,'ok',?,?,?,?,NULL) ON CONFLICT(date) DO UPDATE SET "
                     "status='ok',checked_at=excluded.checked_at,fetched_at=excluded.fetched_at,source=excluded.source,"
                     "raw_paths=excluded.raw_paths,error=NULL", (day, now, now, source, json.dumps(raw_paths)))
        bump_suspension_revision(conn)


def suspended_leaders(conn, day):
    settings = get_settings(conn)
    calendar = sorted(set(settings.get("calendar_dates", [])) | {r[0] for r in conn.execute("SELECT date FROM days WHERE status='ok'")})
    result = []
    for suspension in conn.execute("SELECT * FROM suspension_records WHERE date=? AND full_day=1", (day,)):
        start_day = suspension["start"][:10]
        previous = next((d for d in reversed(calendar) if d < start_day), None)
        if not previous:
            continue
        event = conn.execute("SELECT * FROM events WHERE code=? AND date=? AND boards>=2", (suspension["code"], previous)).fetchone()
        # Never carry an old peak past a later traded day or into the actual pool.
        intervening = conn.execute("SELECT 1 FROM events WHERE code=? AND date>? AND date<=? LIMIT 1",
                                   (suspension["code"], previous, day)).fetchone()
        previous_day = conn.execute("SELECT status FROM days WHERE date=?", (previous,)).fetchone()
        if not event or intervening or not previous_day or previous_day[0] != "ok":
            continue
        result.append({**dict(event), "date": day, "suspended": True, "board_date": previous,
                       "suspension_start": start_day, "resume_date": suspension["resume"],
                       "suspension_reason": suspension["reason"]})
    enrich_industries(conn, result)
    return sorted(result, key=lambda row: (-row["boards"], row["code"]))


def save_industries(conn, records, source, fetched_at, raw_paths):
    """Commit a fully validated industry snapshot without editing event facts."""
    with conn:
        for row in records:
            conn.execute("INSERT INTO stock_industries VALUES (?,?,?,?,?,?,?,?,?) "
                         "ON CONFLICT(code) DO UPDATE SET industry=excluded.industry, "
                         "industry_level2=excluded.industry_level2, industry_level3=excluded.industry_level3, "
                         "industry_code=excluded.industry_code, effective_from=excluded.effective_from, "
                         "source_updated_at=excluded.source_updated_at, source=excluded.source, fetched_at=excluded.fetched_at",
                         (row["code"], row["industry"], row["industry_level2"], row["industry_level3"],
                          row["industry_code"], row["effective_from"], row["source_updated_at"], source, fetched_at))
        values = {"industry_status": "ok", "industry_source": source, "industry_fetched_at": fetched_at,
                  "industry_count": len(records), "industry_raw_paths": raw_paths, "industry_error": None}
        for key, value in values.items():
            conn.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (key, json.dumps(value, ensure_ascii=False)))


def save_default_tags(conn, records, source):
    """Keep verified defaults separate from every user edit and historical fact."""
    with conn:
        for row in records:
            conn.execute("INSERT INTO stock_default_tags VALUES (?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET "
                         "tags_json=excluded.tags_json,ths_tags_json=excluded.ths_tags_json,"
                         "cls_tags_json=excluded.cls_tags_json,source=excluded.source,fetched_at=excluded.fetched_at",
                         (row["code"], json.dumps(row["tags"], ensure_ascii=False),
                          json.dumps(row["ths_tags"], ensure_ascii=False), json.dumps(row["cls_tags"], ensure_ascii=False),
                          source, row["fetched_at"]))


def default_tag_map(conn, codes, industries):
    if get_settings(conn).get("default_tag_mode") != "concept_intersection":
        return {code: {"tags": [industry] if industry else [], "source": "申万一级行业", "fetched_at": None}
                for code, industry in industries.items()}
    return {r["code"]: {"tags": json.loads(r["tags_json"]), "source": r["source"], "fetched_at": r["fetched_at"]}
            for r in conn.execute("SELECT * FROM stock_default_tags WHERE code IN (" +
                                  ",".join("?" for _ in codes) + ")", codes)} if codes else {}


def effective_stock_tags(custom, defaults, excluded=(), merge_defaults=False):
    """Keep user spellings/order first, then append distinct current defaults."""
    if not merge_defaults:
        return list(custom if custom is not None else defaults)
    hidden = {tag.casefold() for tag in excluded}
    result, seen = [], set()
    for tag in (custom or []):
        if tag.casefold() not in seen:
            result.append(tag)
            seen.add(tag.casefold())
    for tag in defaults:
        key = tag.casefold()
        if key not in hidden and key not in seen:
            result.append(tag)
            seen.add(key)
    return result


def get_tag_aliases(conn):
    return {r["tag_key"]: r["name"] for r in conn.execute("SELECT * FROM tag_aliases")}


def get_deleted_tag_keys(conn):
    return {row[0] for row in conn.execute("SELECT tag_key FROM deleted_tags")}


def named_stock_tags(tags, aliases, deleted=()):
    result, seen = [], set()
    for tag in tags:
        name = aliases.get(tag.casefold(), tag)
        if name.casefold() not in deleted and name.casefold() not in seen:
            result.append(name)
            seen.add(name.casefold())
    return result


def rewrite_tag_names(conn, names):
    """Materialize current names without reserving the previous spellings.

    Renamed default memberships become personal labels, with their original
    source names excluded on those stocks. Provider refreshes cannot undo the
    rename, while new uses of an old name stay independent. The caller owns
    the transaction and global revision; raw provider records stay intact.
    """
    industries = {r["code"]: r["industry"] for r in conn.execute("SELECT code,industry FROM stock_industries")}
    codes = [r[0] for r in conn.execute("SELECT code FROM stocks")]
    defaults = default_tag_map(conn, codes, industries)
    overrides = {r["code"]: r for r in conn.execute("SELECT * FROM stock_tag_overrides")}
    exclusions = {r["code"]: json.loads(r["tags_json"]) for r in conn.execute("SELECT * FROM stock_tag_exclusions")}
    merge = get_settings(conn).get("default_tag_mode") == "concept_intersection"
    for code in codes:
        override = overrides.get(code)
        custom = json.loads(override["tags_json"]) if override and override["tags_json"] is not None else None
        source = defaults.get(code, {}).get("tags", [])
        hidden = exclusions.get(code, [])
        updated = named_stock_tags(custom, names) if custom is not None else None
        excluded = list(hidden)
        if merge:
            hidden_keys = {tag.casefold() for tag in hidden}
            for tag in source:
                target = names.get(tag.casefold(), tag)
                if target != tag:
                    if tag.casefold() not in hidden_keys:
                        updated = named_stock_tags((updated or []) + [target], {})
                    if tag.casefold() not in {name.casefold() for name in excluded}:
                        excluded.append(tag)
        elif custom is None and named_stock_tags(source, names) != source:
            updated = named_stock_tags(source, names)
        if updated == custom and excluded == hidden:
            continue
        conn.execute("INSERT INTO stock_tag_overrides VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET tags_json=excluded.tags_json,revision=excluded.revision,updated_at=excluded.updated_at",
                     (code, json.dumps(updated, ensure_ascii=False) if updated is not None else None,
                      (override["revision"] if override else 0) + 1, now_iso()))
        conn.execute("INSERT INTO stock_tag_exclusions VALUES (?,?) ON CONFLICT(code) DO UPDATE SET tags_json=excluded.tags_json",
                     (code, json.dumps(excluded, ensure_ascii=False)))


def tag_alias_revision(conn):
    return get_settings(conn).get("tag_alias_revision", 0)


def enrich_industries(conn, rows):
    codes = list({row["code"] for row in rows})
    if not codes:
        return rows
    industries = {r["code"]: dict(r) for r in conn.execute(
        "SELECT * FROM stock_industries WHERE code IN (" + ",".join("?" for _ in codes) + ")", codes)}
    for row in rows:
        current = industries.get(row["code"])
        if current:
            row.update(industry=current["industry"], industry_source=current["source"],
                       industry_as_of=current["fetched_at"], industry_effective_from=current["effective_from"])
    registrations = {r["code"]: dict(r) for r in conn.execute(
        "SELECT * FROM company_registrations WHERE code IN (" + ",".join("?" for _ in codes) + ")", codes)}
    for row in rows:
        registration = registrations.get(row["code"])
        if registration:
            row.update(registered_province=registration["province"],
                       registration_source=registration["source"], registration_as_of=registration["fetched_at"])
    overrides = {r["code"]: dict(r) for r in conn.execute(
        "SELECT * FROM stock_tag_overrides WHERE code IN (" + ",".join("?" for _ in codes) + ")", codes)}
    defaults = default_tag_map(conn, codes, {row["code"]: row.get("industry") for row in rows})
    merge_defaults = get_settings(conn).get("default_tag_mode") == "concept_intersection"
    exclusions = {r["code"]: json.loads(r["tags_json"]) for r in conn.execute(
        "SELECT * FROM stock_tag_exclusions WHERE code IN (" + ",".join("?" for _ in codes) + ")", codes)}
    aliases = get_tag_aliases(conn)
    deleted = get_deleted_tag_keys(conn)
    for row in rows:
        override = overrides.get(row["code"])
        customized = bool(override and override["tags_json"] is not None)
        default = defaults.get(row["code"], {})
        custom = json.loads(override["tags_json"]) if customized else None
        row.update(tags=named_stock_tags(effective_stock_tags(custom, default.get("tags", []), exclusions.get(row["code"], []), merge_defaults), aliases, deleted),
                   source_tags=named_stock_tags(default.get("tags", []), aliases, deleted), tags_source=default.get("source"),
                   tags_as_of=default.get("fetched_at"),
                   tags_customized=customized, tags_revision=override["revision"] if override else 0)
    notes = {r["code"]: r["content"] for r in conn.execute(
        "SELECT code,content FROM stock_notes WHERE code IN (" + ",".join("?" for _ in codes) + ")", codes)}
    for row in rows:
        row["note"] = notes.get(row["code"], "")
    return rows


class TagConflictError(ValueError):
    pass


def get_stock_tags(conn, code):
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请输入六位股票代码")
    stock = conn.execute("SELECT name FROM stocks WHERE code=?", (code,)).fetchone()
    if stock is None:
        raise ValueError("这只股票尚未收录")
    industry = conn.execute("SELECT industry FROM stock_industries WHERE code=?", (code,)).fetchone()
    source_tag = industry[0] if industry else None
    default = default_tag_map(conn, [code], {code: source_tag}).get(code, {})
    source_tags = default.get("tags", [])
    override = conn.execute("SELECT * FROM stock_tag_overrides WHERE code=?", (code,)).fetchone()
    customized = bool(override and override["tags_json"] is not None)
    custom_tags = json.loads(override["tags_json"]) if customized else []
    hidden = conn.execute("SELECT tags_json FROM stock_tag_exclusions WHERE code=?", (code,)).fetchone()
    excluded = json.loads(hidden[0]) if hidden else []
    merge_defaults = get_settings(conn).get("default_tag_mode") == "concept_intersection"
    aliases = get_tag_aliases(conn)
    deleted = get_deleted_tag_keys(conn)
    return {"code": code, "name": stock["name"], "source_tag": source_tag,
            "source_tags": named_stock_tags(source_tags, aliases, deleted), "tags_source": default.get("source"), "tags_as_of": default.get("fetched_at"),
            "custom_tags": named_stock_tags(custom_tags, aliases, deleted), "excluded_tags": excluded, "merge_defaults": merge_defaults,
            "tag_alias_revision": tag_alias_revision(conn),
            "tags": named_stock_tags(effective_stock_tags(custom_tags if customized else None, source_tags, excluded, merge_defaults), aliases, deleted),
            "customized": customized, "revision": override["revision"] if override else 0,
            "blacklisted": conn.execute("SELECT 1 FROM stock_blacklist WHERE code=?", (code,)).fetchone() is not None}


def save_stock_tags(conn, code, tags, revision, use_source=False, alias_revision=None, *, _commit=True):
    current = get_stock_tags(conn, code)
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise ValueError("标签版本无效，请重新打开编辑窗口")
    if revision != current["revision"]:
        raise TagConflictError("标签已在其他窗口修改，请重新打开后编辑")
    if alias_revision is not None and (type(alias_revision) is not int or alias_revision != current["tag_alias_revision"]):
        raise TagConflictError("标签已全局改名或合并，请重新打开标签窗口")
    if not isinstance(use_source, bool):
        raise ValueError("标签来源选项无效")
    limit = max(20, len(current["tags"]), len(current["source_tags"]) + (20 if current["merge_defaults"] else 0))
    if not isinstance(tags, list) or len(tags) > limit:
        raise ValueError(f"每只股票最多保留 {limit} 个标签")
    clean, seen = [], set()
    for tag in tags:
        if not isinstance(tag, str):
            raise ValueError("标签必须是文字")
        tag = tag.strip()
        if not tag or len(tag) > 30 or any(ord(char) < 32 or ord(char) == 127 for char in tag):
            raise ValueError("标签需为 1 至 30 个字符")
        key = tag.casefold()
        if key not in seen:
            seen.add(key)
            clean.append(tag)
    aliases = get_tag_aliases(conn)
    clean = named_stock_tags(clean, aliases)
    deleted = get_deleted_tag_keys(conn)
    if not use_source and any(tag.casefold() in deleted for tag in clean):
        raise ValueError("该标签已被整体删除，请使用其他标签名称")
    excluded = []
    if current["merge_defaults"] and not use_source:
        source = default_tag_map(conn, [code], {}).get(code, {}).get("tags", [])
        source_keys = {tag.casefold() for tag in current["source_tags"]}
        manual_keys = {tag.casefold() for tag in current["custom_tags"]}
        selected = {tag.casefold() for tag in clean}
        raw_source_keys = {tag.casefold() for tag in source}
        excluded = [tag for tag in current["excluded_tags"] if tag.casefold() not in raw_source_keys and aliases.get(tag.casefold(), tag).casefold() not in selected]
        excluded += [tag for tag in source if aliases.get(tag.casefold(), tag).casefold() not in selected]
        clean = [tag for tag in clean if tag.casefold() not in source_keys or tag.casefold() in manual_keys]
        if len(clean) > max(20, len(current["custom_tags"])):
            raise ValueError("每只股票最多添加 20 个自定义标签")
    payload = None if use_source else json.dumps(clean, ensure_ascii=False)
    with (conn if _commit else nullcontext()):
        if not conn.in_transaction:
            conn.execute("BEGIN IMMEDIATE")
        if tag_alias_revision(conn) != current["tag_alias_revision"]:
            raise TagConflictError("标签已全局改名或合并，请重新打开标签窗口")
        cursor = conn.execute("INSERT INTO stock_tag_overrides VALUES (?,?,?,?) "
                              "ON CONFLICT(code) DO UPDATE SET tags_json=excluded.tags_json, "
                              "revision=excluded.revision, updated_at=excluded.updated_at "
                              "WHERE stock_tag_overrides.revision=?",
                              (code, payload, revision + 1, now_iso(), revision))
        if cursor.rowcount != 1:
            raise TagConflictError("标签已在其他窗口修改，请重新打开后编辑")
        conn.execute("INSERT INTO stock_tag_exclusions VALUES (?,?) ON CONFLICT(code) DO UPDATE SET tags_json=excluded.tags_json",
                     (code, json.dumps(excluded, ensure_ascii=False)))
    return get_stock_tags(conn, code)


class NoteConflictError(ValueError):
    pass


def get_stock_note(conn, code):
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请输入六位股票代码")
    stock = conn.execute("SELECT name FROM stocks WHERE code=?", (code,)).fetchone()
    if stock is None:
        raise ValueError("这只股票尚未收录")
    note = conn.execute("SELECT * FROM stock_notes WHERE code=?", (code,)).fetchone()
    entries = [dict(row) for row in conn.execute(
        "SELECT e.id,e.occurred_at,e.content,e.updated_at,COALESCE(o.note_date,substr(e.occurred_at,1,10)) AS note_date "
        "FROM stock_note_entries e LEFT JOIN stock_note_options o ON o.entry_id=e.id "
        "WHERE e.code=? AND o.deleted_at IS NULL ORDER BY e.occurred_at DESC,e.id DESC", (code,))]
    return {"code": code, "name": stock["name"], "content": note["content"] if note else "",
            "revision": note["revision"] if note else 0, "updated_at": note["updated_at"] if note else None,
            "entries": entries, "latest_entry_id": entries[0]["id"] if entries else None}


def note_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:Z|[+-][0-9]{2}:[0-9]{2})?", value):
        raise ValueError("请输入有效的备注时间")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (stamp if stamp.tzinfo else stamp.replace(tzinfo=TZ)).astimezone(TZ).isoformat(timespec="seconds")
    except (ValueError, OverflowError):
        raise ValueError("请输入有效的备注时间") from None


def latest_stock_note_content(conn, code):
    latest = conn.execute("SELECT e.content FROM stock_note_entries e LEFT JOIN stock_note_options o ON o.entry_id=e.id "
                          "WHERE e.code=? AND o.deleted_at IS NULL ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1", (code,)).fetchone()
    return latest["content"] if latest else ""


def save_stock_note(conn, code, content, revision, *, entry_id=None, occurred_at=None, new_entry=False, note_date=NOTE_DATE_UNSET):
    current = get_stock_note(conn, code)
    if type(revision) is not int or revision < 0:
        raise ValueError("备注版本无效，请重新打开备注窗口")
    if revision != current["revision"]:
        raise NoteConflictError("备注已在其他窗口修改；你的输入已保留，请重新读取后编辑")
    if not isinstance(content, str):
        raise ValueError("备注必须是文字")
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    if len(content) > 5000:
        raise ValueError("备注最多 5000 个字符")
    if any(ord(char) < 32 and char not in "\n\t" or ord(char) == 127 for char in content):
        raise ValueError("备注包含不支持的控制字符")
    if not content.strip():
        content = ""
    if type(new_entry) is not bool or entry_id is not None and (type(entry_id) is not int or entry_id < 1):
        raise ValueError("备注时间节点无效，请重新打开备注窗口")
    if new_entry and entry_id is not None:
        raise ValueError("新增备注不能同时选择历史时间节点")
    selected = None
    if not new_entry:
        selected = next((entry for entry in current["entries"] if entry["id"] == entry_id), None) if entry_id is not None else next(iter(current["entries"]), None)
        if entry_id is not None and selected is None:
            raise ValueError("这条历史备注不存在，请重新打开备注窗口")
    stamp = note_timestamp(occurred_at) if occurred_at is not None else selected["occurred_at"] if selected else now_iso()
    if note_date is not NOTE_DATE_UNSET:
        note_date = "" if note_date is None else note_date
        if not isinstance(note_date, str) or note_date and not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", note_date):
            raise ValueError("备注日期应为年月日，也可以留空")
        if note_date:
            try:
                date.fromisoformat(note_date)
            except ValueError:
                raise ValueError("请输入有效的备注日期") from None
            if not selected or note_date != selected["occurred_at"][:10]:
                stamp = note_date + now_iso()[10:]
    updated_at = now_iso()
    with conn:
        cursor = conn.execute("INSERT INTO stock_notes VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET "
                              "content=excluded.content,revision=excluded.revision,updated_at=excluded.updated_at "
                              "WHERE stock_notes.revision=?", (code, current["content"], revision + 1, updated_at, revision))
        if cursor.rowcount != 1:
            raise NoteConflictError("备注已在其他窗口修改；你的输入已保留，请重新读取后编辑")
        if selected:
            conn.execute("UPDATE stock_note_entries SET content=?,occurred_at=?,updated_at=? WHERE id=? AND code=?",
                         (content, stamp, updated_at, selected["id"], code))
        else:
            inserted = conn.execute("INSERT INTO stock_note_entries(code,occurred_at,content,updated_at) VALUES (?,?,?,?)",
                                    (code, stamp, content, updated_at))
            entry_id = inserted.lastrowid
        if note_date is not NOTE_DATE_UNSET:
            conn.execute("INSERT INTO stock_note_options(entry_id,note_date) VALUES (?,?) "
                         "ON CONFLICT(entry_id) DO UPDATE SET note_date=excluded.note_date", (selected["id"] if selected else entry_id, note_date))
        conn.execute("UPDATE stock_notes SET content=? WHERE code=?", (latest_stock_note_content(conn, code), code))
    return get_stock_note(conn, code)


def change_stock_note_entry(conn, code, entry_id, revision, action):
    current = get_stock_note(conn, code)
    if type(revision) is not int or revision < 0:
        raise ValueError("备注版本无效，请重新打开备注窗口")
    if revision != current["revision"]:
        raise NoteConflictError("备注已在其他窗口修改；你的输入已保留，请重新读取后编辑")
    if action not in ("delete", "restore") or type(entry_id) is not int or entry_id < 1:
        raise ValueError("备注操作或时间节点无效")
    entry = conn.execute("SELECT e.id,o.deleted_at FROM stock_note_entries e LEFT JOIN stock_note_options o ON o.entry_id=e.id "
                         "WHERE e.id=? AND e.code=?", (entry_id, code)).fetchone()
    if entry is None or (action == "delete") == bool(entry["deleted_at"]):
        raise ValueError("这条备注的状态已变化，请重新读取后操作")
    with conn:
        cursor = conn.execute("UPDATE stock_notes SET revision=?,updated_at=? WHERE code=? AND revision=?",
                              (revision + 1, now_iso(), code, revision))
        if cursor.rowcount != 1:
            raise NoteConflictError("备注已在其他窗口修改；你的输入已保留，请重新读取后编辑")
        conn.execute("INSERT INTO stock_note_options(entry_id,deleted_at) VALUES (?,?) "
                     "ON CONFLICT(entry_id) DO UPDATE SET deleted_at=excluded.deleted_at", (entry_id, now_iso() if action == "delete" else None))
        conn.execute("UPDATE stock_notes SET content=? WHERE code=?", (latest_stock_note_content(conn, code), code))
    return get_stock_note(conn, code)


def get_blacklist(conn):
    rows = [dict(row) for row in conn.execute(
        "SELECT b.code,s.name,s.market,b.created_at FROM stock_blacklist b "
        "JOIN stocks s ON s.code=b.code ORDER BY b.created_at DESC,b.code")]
    for offset in range(0, len(rows), 500):
        enrich_industries(conn, rows[offset:offset + 500])
    return {"rows": rows, "total": len(rows)}


def save_blacklist(conn, code, action):
    if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请输入六位股票代码")
    if action not in ("add", "remove"):
        raise ValueError("黑名单操作应为 add 或 remove")
    if conn.execute("SELECT 1 FROM stocks WHERE code=?", (code,)).fetchone() is None:
        raise ValueError("这只股票尚未收录，请从搜索结果中选择")
    with conn:
        if action == "add":
            cursor = conn.execute("INSERT INTO stock_blacklist(code,created_at) VALUES (?,?) "
                                  "ON CONFLICT(code) DO NOTHING", (code, now_iso()))
        else:
            cursor = conn.execute("DELETE FROM stock_blacklist WHERE code=?", (code,))
    return {**get_blacklist(conn), "code": code, "action": action, "changed": cursor.rowcount == 1}


def save_registrations(conn, records, source, fetched_at, raw_paths, requested_count):
    with conn:
        for row in records:
            province = normalize_province(row["province"])
            if not province:
                raise ValueError("注册省份无效")
            # Retain empty legacy columns for compatibility with existing archive copies.
            conn.execute("INSERT INTO company_registrations VALUES (?,?,?,?,?,?,?) "
                         "ON CONFLICT(code) DO UPDATE SET province=excluded.province, city=excluded.city, "
                         "location=excluded.location, address=excluded.address, source=excluded.source, fetched_at=excluded.fetched_at",
                         (row["code"], province, "", "", "", source, fetched_at))
        values = {"registration_status": "ok", "registration_source": source,
                  "registration_fetched_at": fetched_at, "registration_count": len(records),
                  "registration_requested": requested_count, "registration_raw_paths": [],
                  "registration_error": None}
        for key, value in values.items():
            conn.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         (key, json.dumps(value, ensure_ascii=False)))


def market_for(code):
    if code.startswith(("688", "689")):
        return "科创板"
    if code.startswith(("300", "301")):
        return "创业板"
    if code.startswith(("8", "4", "92")):
        return "北交所"
    return "沪市主板" if code.startswith("6") else "深市主板"


def validated_records(day, records, source):
    """Shared validation for confirmed facts and isolated provisional snapshots."""
    if date.fromisoformat(day).isoformat() != day:
        raise ValueError("日期必须是 YYYY-MM-DD")
    clean = []
    seen = set()
    for item in records:
        row = dict(item)
        code = str(row["code"])
        if len(code) != 6 or not code.isascii() or not code.isdigit():
            raise ValueError("股票代码必须是六位数字")
        if code in seen:
            raise ValueError("同一交易日有重复股票")
        seen.add(code)
        if row.get("date", day) != day:
            raise ValueError("数据返回日期与请求日期不一致")
        try:
            board_value = Decimal(str(row["boards"]))
        except (InvalidOperation, ValueError) as exc:
            raise ValueError("连板数必须为正整数") from exc
        if not board_value.is_finite() or board_value != board_value.to_integral_value() or board_value < 1:
            raise ValueError("涨停池的连板数必须大于等于 1")
        if not isinstance(row.get("name"), str) or not row["name"].strip():
            raise ValueError("股票名称不能为空")
        for field in ("close", "pct_change", "turnover"):
            if row.get(field) is not None and not math.isfinite(float(row[field])):
                raise ValueError(f"{field} 不是有效数值")
        row.update(date=day, code=code, boards=int(board_value), source=source,
                   market=row.get("market") or market_for(code))
        clean.append(row)
    return clean


def save_day(conn, day, records, source, status="ok", note="", raw_path=None):
    """Validate an entire day before writing it; a failed fetch cannot erase a valid day."""
    if status not in {"ok", "empty", "failed", "unknown"}:
        raise ValueError("不支持的数据覆盖状态")
    if status != "ok" and records:
        raise ValueError("未确认日期的数据不能写入涨停档案")
    clean = validated_records(day, records, source)
    previous = conn.execute("SELECT status FROM days WHERE date=?", (day,)).fetchone()
    if status != "ok" and previous and previous["status"] == "ok":
        return False
    keys = ["date", "code", "name", "market", "industry", "boards", "close", "pct_change",
            "turnover", "first_time", "last_time", "open_times", "limit_up_reason", "source"]
    with conn:
        # The input is a full validated daily snapshot, so replace that day's facts atomically.
        # This changes database rows only; no filesystem paths are deleted.
        if status == "ok":
            conn.execute("DELETE FROM events WHERE date=?", (day,))
        for row in clean:
            conn.execute("INSERT INTO events (" + ",".join(keys) + ") VALUES (" + ",".join("?" for _ in keys) + ") "
                         "ON CONFLICT(date,code) DO UPDATE SET " + ",".join(f"{k}=excluded.{k}" for k in keys[2:]),
                         tuple(row.get(k) for k in keys))
            conn.execute("INSERT INTO stocks VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET "
                         "name=CASE WHEN excluded.last_seen >= stocks.last_seen THEN excluded.name ELSE stocks.name END, "
                         "market=excluded.market, last_seen=MAX(stocks.last_seen,excluded.last_seen)",
                         (row["code"], row["name"], row["market"], day))
        conn.execute("INSERT INTO days VALUES (?,?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET "
                     "status=excluded.status, source=excluded.source, note=excluded.note, "
                     "count=excluded.count, fetched_at=excluded.fetched_at, raw_path=excluded.raw_path",
                     (day, status, source, note, len(clean), now_iso(), raw_path))
    return True


def meta(conn):
    settings = get_settings(conn)
    settings.pop("site_links", None)  # Link configuration has its own public, filtered response.
    start, end = settings["range_start"], settings["range_end"]
    dates = [r[0] for r in conn.execute("SELECT date FROM days WHERE status='ok' AND date BETWEEN ? AND ? ORDER BY date", (start, end))]
    counts = conn.execute("SELECT COUNT(*) records, COUNT(DISTINCT code) stocks FROM events WHERE date BETWEEN ? AND ?", (start, end)).fetchone()
    attempts = Counter(r["status"] for r in conn.execute("SELECT status FROM days WHERE date BETWEEN ? AND ?", (start, end)))
    last = conn.execute("SELECT MAX(fetched_at) FROM days").fetchone()[0]
    archive_updated = conn.execute("SELECT MAX(fetched_at) FROM days WHERE status='ok'").fetchone()[0]
    latest_limit_ups = [dict(r) for r in conn.execute(
        "SELECT code,boards FROM events WHERE date=? ORDER BY code", (dates[-1],))] if dates else []
    examples = [dict(r) for r in conn.execute("SELECT e.code,s.name,MAX(e.boards) highest,COUNT(*) observations FROM events e JOIN stocks s USING(code) WHERE date BETWEEN ? AND ? GROUP BY e.code ORDER BY highest DESC,observations DESC LIMIT 6", (start, end))]
    return {**settings, "latest_date": dates[-1] if dates else None, "dates": dates,
            "suspension_updating": conn.execute("SELECT COUNT(*) FROM suspension_days WHERE status='updating'").fetchone()[0],
            "available_start": dates[0] if dates else None, "available_end": dates[-1] if dates else None,
            "coverage": {"days": len(dates), "stocks": counts["stocks"], "records": counts["records"],
                         "status": settings.get("coverage_status", "partial"),
                         "note": settings.get("coverage_note", settings["scope_note"]), "attempts": dict(attempts)},
            "examples": examples, "updated_at": last, "archive_updated_at": archive_updated,
            "latest_limit_ups": latest_limit_ups}


def is_st_name(name):
    return bool(re.match(r"^\*?ST", re.sub(r"\s+", "", name).upper()))


def date_view(conn, day, min_boards=1, market="all", query="", exclude_st=False, boards=None, exclude_gem=False, *, snapshot=None):
    settings = get_settings(conn)
    market = {"sh": "沪市主板", "sz": "深市主板", "gem": "创业板", "star": "科创板", "bj": "北交所"}.get(market, market)
    coverage = conn.execute("SELECT * FROM days WHERE date=?", (day,)).fetchone()
    rows = [dict(r) for r in conn.execute("SELECT * FROM events WHERE date=? ORDER BY boards DESC,code", (day,))]
    if coverage and coverage["status"] == "ok":
        snapshot = None
    if snapshot:
        coverage = {"status": "provisional", "source": snapshot["source"], "note": snapshot["note"]}
        rows = sorted((dict(r) for r in snapshot["records"]), key=lambda r: (-r["boards"], r["code"]))
    enrich_industries(conn, rows)
    rows = [r for r in rows if (market == "all" or r["market"] == market)
            and (not query or query.casefold() in (r["code"] + r["name"]).casefold())
            and (not exclude_st or not is_st_name(r["name"]))
            and (not exclude_gem or market_for(r["code"]) != "创业板")]
    board_counts = Counter(r["boards"] for r in rows)
    available_total = len(rows)
    # Keep the full day's tag cohorts when the visible rows select one height.
    tag_board_counts = {}
    from tag_management import hierarchy
    parents = {node["name"].casefold(): node["parent"] for node in hierarchy(conn) if node["parent"]}
    def root_tag(name):
        seen = set()
        while name.casefold() in parents and name.casefold() not in seen:
            seen.add(name.casefold())
            name = parents[name.casefold()]
        return name
    for row in rows:
        for tag in dict.fromkeys([*row["tags"], *(root_tag(tag) for tag in row["tags"])]):
            counts = tag_board_counts.setdefault(tag, {})
            height = str(row["boards"])
            counts[height] = counts.get(height, 0) + 1
    if boards is not None and (isinstance(boards, bool) or not isinstance(boards, int) or not 1 <= boards <= 100):
        raise ValueError("连板数应为 1 至 100 的整数")
    rows = [r for r in rows if r["boards"] >= min_boards and (boards is None or r["boards"] == boards)]
    suspended = [r for r in suspended_leaders(conn, day) if r["boards"] >= min_boards
                 and (boards is None or r["boards"] == boards) and (market == "all" or r["market"] == market)
                 and (not query or query.casefold() in (r["code"] + r["name"]).casefold())
                 and (not exclude_st or not is_st_name(r["name"]))
                 and (not exclude_gem or market_for(r["code"]) != "创业板")]
    blacklist_codes = {r[0] for r in conn.execute("SELECT code FROM stock_blacklist")}
    for row in [*rows, *suspended]:
        row["blacklisted"] = row["code"] in blacklist_codes
        row["initials"] = stock_initials(row["name"])
    suspension_day = conn.execute("SELECT * FROM suspension_days WHERE date=?", (day,)).fetchone()
    groups = Counter(r["boards"] for r in rows)
    note = settings["scope_note"]
    if not coverage:
        note = "该日期尚未收录。休市、数据缺失或接口不支持历史日期均可能导致无记录，不能据此判断没有涨停。"
    elif coverage["status"] == "failed":
        note = "该日期的来源数据暂未获取或未通过校验，正在自动重试。不能据此判断当天没有涨停。"
    elif coverage["status"] != "ok":
        note = coverage["note"] or "来源未返回可确认的该日数据，不能据此判断没有涨停。"
    return {"date": day, "coverage_note": note, "data_status": coverage["status"] if coverage else "missing",
            "provisional": bool(snapshot), "fetched_at": snapshot["fetched_at"] if snapshot else coverage["fetched_at"] if coverage else None,
            "source": coverage["source"] if coverage else None,
            "rows": rows, "selected_boards": boards, "available_total": available_total,
            "tag_board_counts": tag_board_counts,
            "suspended_rows": suspended,
            "suspension_status": suspension_day["status"] if suspension_day else "unknown",
            "trading_max_boards": max(groups, default=0),
            "board_counts": [{"boards": k, "count": v} for k, v in sorted(board_counts.items())],
            "stats": {"total": len(rows), "consecutive": sum(r["boards"] >= 2 for r in rows),
                                      "max_boards": max([*groups, *(r["boards"] for r in suspended)], default=0), "first_boards": groups.get(1, 0)},
            "groups": [{"boards": k, "count": v} for k, v in sorted(groups.items(), reverse=True)]}


@lru_cache(maxsize=20000)
def stock_initials(name):
    letters = "".join(lazy_pinyin(unicodedata.normalize("NFKC", name), style=Style.FIRST_LETTER))
    return re.sub(r"[^A-Z0-9]", "", letters.upper())


def search_stocks(conn, query=""):
    query = query.strip()
    initials = re.sub(r"\s+", "", query).upper()
    use_initials = bool(re.fullmatch(r"[A-Z]+", initials))
    conn.create_function("stock_initials", 1, stock_initials, deterministic=True)
    # Match past source-provided names too, rather than only today's name.
    pattern = "%" + query + "%"
    if use_initials:
        rows = conn.execute("SELECT s.code,s.name,s.market FROM stocks s WHERE s.code LIKE ? OR s.name LIKE ? "
                            "OR stock_initials(s.name) LIKE ? OR EXISTS(SELECT 1 FROM events e WHERE e.code=s.code "
                            "AND (e.name LIKE ? OR stock_initials(e.name) LIKE ?)) "
                            "ORDER BY CASE WHEN stock_initials(s.name)=? THEN 0 ELSE 1 END,s.last_seen DESC,s.code LIMIT 40",
                            (pattern, pattern, "%" + initials + "%", pattern, "%" + initials + "%", initials))
    else:
        rows = conn.execute("SELECT s.code,s.name,s.market FROM stocks s WHERE s.code LIKE ? OR s.name LIKE ? "
                            "OR EXISTS(SELECT 1 FROM events e WHERE e.code=s.code AND e.name LIKE ?) "
                            "ORDER BY CASE WHEN s.code=? OR s.name=? THEN 0 ELSE 1 END,s.last_seen DESC,s.code LIMIT 40",
                            (pattern, pattern, pattern, query, query))
    return {"rows": [{**dict(r), "initials": stock_initials(r["name"])} for r in rows]}


def stock_view(conn, code, start, end):
    settings = get_settings(conn)
    stock = conn.execute("SELECT code,name,market FROM stocks WHERE code=?", (code,)).fetchone()
    stock = dict(stock) if stock else {"code": code, "name": "尚未收录", "market": market_for(code)}
    stock["initials"] = stock_initials(stock["name"])
    stock["blacklisted"] = conn.execute("SELECT 1 FROM stock_blacklist WHERE code=?", (code,)).fetchone() is not None
    enrich_industries(conn, [stock])
    # Previous observations establish the first board, but later observations would leak future heights.
    all_rows = [dict(r) for r in conn.execute("SELECT * FROM events WHERE code=? AND date<=? ORDER BY date", (code, end))]
    available_dates = [r[0] for r in conn.execute("SELECT date FROM days WHERE status='ok' ORDER BY date")]
    # A never-fetched trading day is a gap too. Use the provider calendar when available.
    all_dates = sorted(set(settings.get("calendar_dates", []) + available_dates))
    indices = {day: i for i, day in enumerate(all_dates)}
    attempted = {r["date"]: r["status"] for r in conn.execute("SELECT date,status FROM days")}
    cycles = []
    for row in all_rows:
        previous = cycles[-1] if cycles else None
        can_join = bool(previous and row["boards"] == previous["boards"] + 1
                        and indices.get(row["date"], -100) == indices.get(previous["end"], 100) + 1
                        and not any(status != "ok" and previous["end"] < d < row["date"] for d, status in attempted.items()))
        if can_join:
            previous.update(end=row["date"], boards=row["boards"])
            previous["dates"].append(row["date"])
        else:
            cycles.append({"start": row["date"], "end": row["date"], "boards": row["boards"],
                           "dates": [row["date"]], "start_known": row["boards"] == 1})
    selected_dates = [d for d in all_dates if d <= end]
    selected_available = [d for d in available_dates if d <= end]
    latest = selected_available[-1] if selected_available else None
    row_by_date = {r["date"]: r for r in all_rows}
    visible_cycles = []
    for cycle in cycles:
        if cycle["end"] < start or cycle["start"] > end:
            continue
        cycle["ongoing"] = cycle["end"] == latest
        later = [d for d in selected_dates if d > cycle["end"]]
        next_day = later[0] if later else None
        gap = next_day and (attempted.get(next_day) != "ok" or any(status != "ok" and cycle["end"] < d <= next_day for d, status in attempted.items()))
        next_row = row_by_date.get(next_day)
        cycle["end_known"] = bool(next_day and not gap and (next_row is None or next_row["boards"] == 1))
        cycle["clipped"] = cycle["start"] < start or cycle["end"] > end or not cycle["start_known"]
        if cycle["clipped"]:
            cycle["note"] = "含查询区间外记录，或首板日期未收录；该周期可能不完整。"
        visible_cycles.append(cycle)
    rows = [r for r in all_rows if start <= r["date"] <= end]
    note = settings["scope_note"] + " 个股列表仅显示已收录的涨停日；空白不代表断板。"
    relations = stock_relationships(conn, code, start, end, settings)
    competition = relations["competition"]
    peers = [*competition["wins"], *competition["losses"], *relations["cooccurrences"]["rows"]]
    for round_record in competition["rounds"]:
        peers.extend(round_record["wins"])
        peers.extend(round_record["losses"])
        peers.extend(round_record["cohort"])
    # Current company profiles are presentation metadata. Historical names,
    # cohort membership and win/loss evidence remain untouched.
    profiles = {peer["code"]: {"code": peer["code"]} for peer in peers}
    unique_profiles = list(profiles.values())
    for offset in range(0, len(unique_profiles), 500):
        enrich_industries(conn, unique_profiles[offset:offset + 500])
    for peer in peers:
        peer.update(profiles[peer["code"]])
        peer["initials"] = stock_initials(peer["name"])
    return {"stock": stock, "range_start": start, "range_end": end, "as_of_date": latest,
            "stats": {"limit_days": len(rows), "max_boards": max((r["boards"] for r in rows), default=0), "cycles": len(visible_cycles)},
            "cycles": list(reversed(visible_cycles)), "rows": list(reversed(rows)), "coverage_note": note,
            "relationships": relations}
