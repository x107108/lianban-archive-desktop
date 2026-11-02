"""Activate a downloaded Mac release, retaining the previous copy and snapshot."""
from contextlib import closing
from pathlib import Path
import argparse
import json
import sqlite3
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parent


def main(base, no_browser=False):
    base = base.resolve()
    marker = base / 'managed-project.txt'
    if not marker.exists() or marker.read_text().strip() != 'lianban-archive-desktop-macos':
        raise RuntimeError('不能接管未识别的安装目录。')
    active = base / 'active.txt'
    old = (base / active.read_text().strip()).resolve() if active.exists() else None
    if old and (not old.is_relative_to(base / 'versions') or not (old / 'BUNDLE.json').is_file()):
        raise RuntimeError('原安装记录无效，旧文件已保留。')
    def run(root, action, *extra):
        return subprocess.run([str(root / 'launcher-macos.command'), action, *extra], cwd=root, check=True)
    version = json.loads((ROOT / 'VERSION.json').read_text())['version']
    extra = ['--no-browser'] if no_browser else []
    if old and json.loads((old / 'VERSION.json').read_text())['version'] == version:
        run(old, 'verify')
        run(old, 'start', *extra)
        print('已复用当前版本：' + str(old))
        return
    run(ROOT, 'verify')
    was_running = False
    if old:
        # Ask the old interpreter about its own copy, not the new ROOT.
        python = old / '.runtime/macos/python/bin/python3'
        result = subprocess.run([str(python), '-c', 'import launcher_macos; print(bool(launcher_macos.session()))'],
                                cwd=old, check=True, capture_output=True, text=True)
        was_running = result.stdout.strip() == 'True'
        run(old, 'stop')
    try:
        if old and (old / 'data/archive.sqlite3').exists():
            snapshots = base / 'snapshots'
            snapshots.mkdir(exist_ok=True)
            snapshot = snapshots / ('before-' + version + '-' + uuid.uuid4().hex + '.sqlite3')
            with closing(sqlite3.connect((old / 'data/archive.sqlite3').as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(snapshot)) as target:
                source.backup(target)
            (ROOT / 'data').mkdir(exist_ok=True)
            with closing(sqlite3.connect(snapshot.as_uri() + '?mode=ro', uri=True)) as source, closing(sqlite3.connect(ROOT / 'data/archive.sqlite3')) as target:
                source.backup(target)
        run(ROOT, 'install')
        run(ROOT, 'start', *extra)
    except (OSError, subprocess.CalledProcessError):
        run(ROOT, 'stop')
        if old and was_running:
            run(old, 'start', *extra)
        raise
    temporary = base / ('active-' + uuid.uuid4().hex + '.txt')
    temporary.write_text(str(ROOT.relative_to(base)) + '\n')
    temporary.replace(active)
    for name, action in (('启动连板档案.command', 'start'), ('停止连板档案.command', 'stop')):
        path = base / name
        path.write_text('#!/bin/bash\nset -e\ncd -- "$(dirname -- "$0")"\n'
                        'active="$(cat active.txt)"\nexec "./$active/launcher-macos.command" ' + action + ' "$@"\n')
        path.chmod(0o755)
    print('安装目录：' + str(ROOT))
    print('以后请使用此处的启停入口：' + str(base))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('base', type=Path)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    main(args.base, args.no_browser)
