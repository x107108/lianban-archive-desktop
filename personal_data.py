"""Import explicitly exported personal records, never a publisher's private DB."""
from contextlib import closing
from datetime import date, datetime
from pathlib import Path
import hashlib
import json
import re
import sqlite3
import uuid

import database as db

MAX_BYTES = 20 * 1024 * 1024


def validate(data):
    if not isinstance(data, dict) or data.get('format') != 'lianban-personal-data' or data.get('version') != 1:
        raise ValueError('请选择连板档案导出的个人数据文件。')
    def label(value):
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 30 or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError('文件中的标签格式无效。')
        return value.strip()
    def labels(values):
        if not isinstance(values, list) or len(values) > 100:
            raise ValueError('文件中的标签数量无效。')
        return list({label(v).casefold(): label(v) for v in values}.values())
    def stamp(value):
        if not isinstance(value, str) or len(value) > 40:
            raise ValueError('文件中的备注时间无效。')
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return (parsed if parsed.tzinfo else parsed.replace(tzinfo=db.TZ)).astimezone(db.TZ).isoformat(timespec='seconds')
    rows, nodes = data.get('stocks'), data.get('hierarchy', [])
    if not isinstance(rows, list) or len(rows) > 15000 or not isinstance(nodes, list) or len(nodes) > 10000:
        raise ValueError('文件中的股票或标签层级数量无效。')
    clean, codes = [], set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('code'), str) or not re.fullmatch(r'[0-9]{6}', row['code']) or row['code'] in codes:
            raise ValueError('文件中的股票代码无效或重复。')
        codes.add(row['code'])
        name = row.get('name')
        if not isinstance(name, str) or not name.strip() or len(name) > 100:
            raise ValueError('文件中的股票名称无效。')
        item = {'code': row['code'], 'name': name.strip()}
        if 'tags' in row:
            if not isinstance(row['tags'], dict):
                raise ValueError('文件中的标签格式无效。')
            item['tags'] = {'values': labels(row['tags'].get('values')), 'source': labels(row['tags'].get('source', []))}
        if 'blacklisted' in row:
            if type(row['blacklisted']) is not bool:
                raise ValueError('文件中的黑名单格式无效。')
            item['blacklisted'] = row['blacklisted']
        if 'notes' in row:
            if not isinstance(row['notes'], list) or len(row['notes']) > 10000:
                raise ValueError('文件中的备注数量无效。')
            item['notes'] = []
            for note in row['notes']:
                if not isinstance(note, dict) or not isinstance(note.get('content'), str) or len(note['content']) > 5000 or any(ord(c) < 32 and c not in '\n\r\t' or ord(c) == 127 for c in note['content']):
                    raise ValueError('文件中的备注内容无效。')
                note_date = note.get('note_date', note.get('occurred_at', '')[:10])
                if not isinstance(note_date, str) or note_date and date.fromisoformat(note_date).isoformat() != note_date:
                    raise ValueError('文件中的备注日期无效。')
                item['notes'].append({'content': note['content'].replace('\r\n', '\n').replace('\r', '\n'),
                    'occurred_at': stamp(note.get('occurred_at')), 'updated_at': stamp(note.get('updated_at', note.get('occurred_at'))),
                    'note_date': note_date, 'deleted_at': stamp(note['deleted_at']) if note.get('deleted_at') else None})
        clean.append(item)
    hierarchy = {}
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError('标签层级格式无效。')
        name, parent = label(node.get('name')), label(node['parent']) if node.get('parent') else ''
        if name.casefold() in hierarchy:
            raise ValueError('文件中存在重复的标签层级。')
        hierarchy[name.casefold()] = {'name': name, 'parent': parent}
    for node in hierarchy.values():
        seen, parent = {node['name'].casefold()}, node['parent'].casefold()
        while parent:
            if parent in seen or parent not in hierarchy:
                raise ValueError('标签层级存在循环或缺少父级。')
            seen.add(parent)
            parent = hierarchy[parent]['parent'].casefold()
    preferences = data.get('preferences', {})
    allowed = {'limit-up-archive.shareholder-blocked-types.v1'}
    if not isinstance(preferences, dict) or set(preferences) - allowed:
        raise ValueError('文件中的浏览器偏好格式无效。')
    for value in preferences.values():
        if not isinstance(value, str) or len(value) > 2000 or not isinstance(json.loads(value), list) or any(not isinstance(v, str) or len(v) > 30 for v in json.loads(value)):
            raise ValueError('文件中的股东屏蔽选择无效。')
    return {'format': 'lianban-personal-data', 'version': 1, 'stocks': clean,
            'hierarchy': list(hierarchy.values()), 'preferences': preferences}


def summary(data):
    return {'stocks': len(data['stocks']), 'tag_stocks': sum('tags' in r for r in data['stocks']),
            'notes': sum(len(r.get('notes', [])) for r in data['stocks']),
            'blacklist': sum(r.get('blacklisted', False) for r in data['stocks']), 'hierarchy': len(data['hierarchy'])}


def import_data(path, data):
    digest = hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    path = Path(path).resolve()
    with closing(db.connect(path)) as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS personal_data_imports(digest TEXT PRIMARY KEY, imported_at TEXT NOT NULL)')
        if conn.execute('SELECT 1 FROM personal_data_imports WHERE digest=?', (digest,)).fetchone():
            return {**summary(data), 'already_imported': True, 'preferences': data['preferences']}
        backup = path.parent / 'backups' / ('before-personal-import-' + uuid.uuid4().hex + '.sqlite3')
        backup.parent.mkdir(exist_ok=True)
        with closing(sqlite3.connect(backup)) as target:
            conn.backup(target)
        counts = {'added_tags': 0, 'added_notes': 0, 'added_blacklist': 0, 'hierarchy_conflicts': 0}
        now = db.now_iso()
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            for row in data['stocks']:
                code = row['code']
                conn.execute('INSERT OR IGNORE INTO stocks VALUES (?,?,?,?)', (code, row['name'], db.market_for(code), now[:10]))
                if 'tags' in row:
                    current = db.get_stock_tags(conn, code)
                    existing = conn.execute('SELECT tags_json FROM stock_tag_overrides WHERE code=?', (code,)).fetchone()
                    local = json.loads(existing[0]) if existing and existing[0] is not None else []
                    combined = list({v.casefold(): v for v in row['tags']['values'] + local}.values())
                    hidden = list(current['excluded_tags'])
                    selected = {v.casefold() for v in combined}
                    hidden += [v for v in row['tags']['source'] if v.casefold() not in selected]
                    hidden = [v for v in dict.fromkeys(hidden) if v.casefold() not in selected]
                    counts['added_tags'] += len(selected - {v.casefold() for v in current['tags']})
                    conn.execute('INSERT INTO stock_tag_overrides VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET tags_json=excluded.tags_json,revision=excluded.revision,updated_at=excluded.updated_at',
                                 (code, json.dumps(combined, ensure_ascii=False), current['revision'] + 1, now))
                    conn.execute('INSERT INTO stock_tag_exclusions VALUES (?,?) ON CONFLICT(code) DO UPDATE SET tags_json=excluded.tags_json', (code, json.dumps(hidden, ensure_ascii=False)))
                changed = False
                for note in row.get('notes', []):
                    exists = conn.execute("SELECT 1 FROM stock_note_entries e LEFT JOIN stock_note_options o ON o.entry_id=e.id WHERE e.code=? AND e.content=? AND e.occurred_at=? AND COALESCE(o.note_date,substr(e.occurred_at,1,10))=? AND COALESCE(o.deleted_at,'')=?",
                                          (code, note['content'], note['occurred_at'], note['note_date'], note['deleted_at'] or '')).fetchone()
                    if exists:
                        continue
                    inserted = conn.execute('INSERT INTO stock_note_entries(code,occurred_at,content,updated_at) VALUES (?,?,?,?)', (code, note['occurred_at'], note['content'], note['updated_at']))
                    conn.execute('INSERT INTO stock_note_options VALUES (?,?,?)', (inserted.lastrowid, note['note_date'], note['deleted_at']))
                    counts['added_notes'] += 1
                    changed = True
                if changed:
                    conn.execute('INSERT INTO stock_notes VALUES (?,?,1,?) ON CONFLICT(code) DO UPDATE SET content=excluded.content,revision=stock_notes.revision+1,updated_at=excluded.updated_at',
                                 (code, db.latest_stock_note_content(conn, code), now))
                if row.get('blacklisted'):
                    counts['added_blacklist'] += conn.execute('INSERT OR IGNORE INTO stock_blacklist VALUES (?,?)', (code, now)).rowcount
            existing_nodes = {r['tag_key']: r['parent_key'] for r in conn.execute('SELECT * FROM tag_nodes')}
            new_nodes = {n['name'].casefold(): n for n in data['hierarchy'] if n['name'].casefold() not in existing_nodes}
            parents = {**existing_nodes, **{k: n['parent'].casefold() or None for k, n in new_nodes.items()}}
            for key, node in new_nodes.items():
                seen, parent = {key}, parents[key]
                while parent:
                    if parent in seen:
                        raise ValueError('与本机标签合并后会形成循环，已取消导入；请先调整同名标签的父级。')
                    seen.add(parent)
                    parent = parents.get(parent)
                conn.execute('INSERT INTO tag_nodes VALUES (?,?,?)', (key, node['name'], node['parent'].casefold() or None))
            counts['hierarchy_conflicts'] = sum(n['name'].casefold() in existing_nodes and (existing_nodes[n['name'].casefold()] or '') != n['parent'].casefold() for n in data['hierarchy'])
            revision = db.tag_alias_revision(conn) + 1
            conn.execute("INSERT INTO settings VALUES ('tag_alias_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(revision),))
            conn.execute('INSERT INTO personal_data_imports VALUES (?,?)', (digest, now))
        return {**summary(data), **counts, 'backup': 'data/backups/' + backup.name,
                'already_imported': False, 'preferences': data['preferences']}
