"""Exercise real Mac upgrades and recovery using synthetic personal records."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys

source = Path(sys.argv[1]).resolve()
base = source.parent / '升级与失败恢复'
base.mkdir()
(base / 'versions').mkdir()
(base / 'managed-project.txt').write_text('lianban-archive-desktop-macos\n')


def copy(name, version, broken=False):
    root = base / 'versions' / name
    shutil.copytree(source, root, symlinks=True, ignore=shutil.ignore_patterns('data', '__pycache__'))
    (root / 'VERSION.json').write_text(json.dumps({'version': version}))
    if broken:
        (root / 'desktop.py').write_text("raise RuntimeError('intentional isolated acceptance failure')\n")
    bundle = json.loads((root / 'BUNDLE.json').read_text())
    for name in ('VERSION.json', 'desktop.py'):
        bundle['sha256'][name] = hashlib.sha256((root / name).read_bytes()).hexdigest()
    bundle['id'] = 'acceptance-' + version
    (root / 'BUNDLE.json').write_text(json.dumps(bundle))
    return root


def run(root, action):
    return subprocess.run([str(root / 'launcher-macos.command'), action, '--no-browser', '--no-updates'], cwd=root, check=True)


old = copy('old', '2026.11.01')
run(old, 'install')
python = old / '.runtime/macos/python/bin/python3'
subprocess.run([str(python), '-c', "import database as d; c=d.connect(); code=c.execute('SELECT code FROM stocks LIMIT 1').fetchone()[0]; d.save_stock_note(c,code,'Mac升级保留备注',0); print('PERSONAL_FIXTURE_OK')"], cwd=old, check=True)
run(old, 'start')
(base / 'active.txt').write_text('versions/old\n')
new = copy('new', '2026.11.02')
def upgrade(root, check=True):
    return subprocess.run([str(root / '.runtime/macos/python/bin/python3'), str(root / 'macos_upgrade.py'), str(base), '--no-browser'], cwd=root, check=check)
upgrade(new)
assert (base / 'active.txt').read_text().strip() == 'versions/new'
new_python = new / '.runtime/macos/python/bin/python3'
subprocess.run([str(new_python), '-c', "import database as d; c=d.connect(); assert c.execute(\"SELECT COUNT(*) FROM stock_note_entries WHERE content='Mac升级保留备注'\").fetchone()[0]==1; print('MIGRATED_NOTE_OK')"], cwd=new, check=True)
assert list((base / 'snapshots').glob('*.sqlite3'))
upgrade(new)
broken = copy('broken', '2026.11.03', broken=True)
assert upgrade(broken, check=False).returncode != 0
assert (base / 'active.txt').read_text().strip() == 'versions/new'
result = subprocess.run([str(new_python), '-c', 'import launcher_macos; assert launcher_macos.session(); print("RECOVERED_OLD_RUNNING_OK")'], cwd=new, check=True)
run(new, 'stop')
print('MACOS_UPGRADE_AND_RECOVERY_OK')
