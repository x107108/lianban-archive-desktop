"""Build the Windows release from tracked public files and verify its manifest."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
version = json.loads((ROOT / 'VERSION.json').read_text(encoding='utf-8'))['version']
output = ROOT / '.build' / ('release-' + ''.join(version.split('.')[:3]))
output.mkdir(parents=True, exist_ok=True)
target = output / f'lianban-archive-desktop-v{version}.zip'
names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode('utf-8').strip('\0').split('\0')
assert not any(name.split('/')[0] in ('data', '.runtime', '.build', '.git') for name in names)
bundle = json.loads((ROOT / 'BUNDLE.json').read_text(encoding='utf-8'))
assert all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == sha for name, sha in bundle['sha256'].items())
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for name in names:
        archive.write(ROOT / name, 'lianban-archive-desktop/' + name)
with zipfile.ZipFile(target) as archive:
    assert all(hashlib.sha256(archive.read('lianban-archive-desktop/' + name)).hexdigest() == sha for name, sha in bundle['sha256'].items())
digest = hashlib.sha256(target.read_bytes()).hexdigest()
target.with_suffix('.zip.sha256').write_text(digest + '  ' + target.name + '\n', encoding='ascii')
print(json.dumps({'file': str(target), 'sha256': digest, 'bytes': target.stat().st_size}))
