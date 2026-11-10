"""Build self-contained Mac archives without copying any personal database."""
from pathlib import Path
import argparse
import hashlib
import io
import json
import tarfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def build(architecture, output):
    output.mkdir(parents=True, exist_ok=True)
    runtimes = json.loads((ROOT / 'macos-runtimes.json').read_text())
    spec = runtimes[architecture]
    runtime = output / f'python-macos-{architecture}.tar.gz'
    if not runtime.exists():
        with urlopen(spec['url'], timeout=120) as response, runtime.open('xb') as handle:
            while chunk := response.read(1024 * 1024):
                handle.write(chunk)
    if hashlib.sha256(runtime.read_bytes()).hexdigest() != spec['sha256']:
        raise ValueError('Mac Python download checksum mismatch; retain file for inspection.')
    bundle = json.loads((ROOT / 'BUNDLE.json').read_text())
    names = {name for name in bundle['sha256'] if not name.startswith('vendor/python-')}
    names.update(('README.md', 'AI_INSTALL.md', 'MACOS.md', 'THIRD_PARTY_NOTICES.md', 'macos-runtimes.json'))
    files = {name: (ROOT / name).read_bytes() for name in names}
    runtime_name = 'vendor/' + runtime.name
    files[runtime_name] = runtime.read_bytes()
    files['MACOS_RUNTIME.sha256'] = (spec['sha256'] + '  ' + runtime_name + '\n').encode()
    for name, action in (('安装连板档案.command', 'install'), ('启动连板档案.command', 'start'),
                         ('停止连板档案.command', 'stop'), ('校验连板档案.command', 'verify')):
        files[name] = ('#!/bin/bash\nset -e\ncd -- "$(dirname -- "$0")"\n'
                       f'./launcher-macos.command {action} "$@"\n').encode('utf-8')
    bundle['runtime'] = runtime_name
    bundle['platform'] = 'macos-' + architecture
    bundle['sha256'] = {name: hashlib.sha256(raw).hexdigest() for name, raw in sorted(files.items())}
    bundle['id'] = hashlib.sha256(json.dumps(bundle['sha256'], sort_keys=True).encode()).hexdigest()[:16]
    files['BUNDLE.json'] = (json.dumps(bundle, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    version = json.loads(files['VERSION.json'])['version']
    target = output / f'lianban-archive-desktop-v{version}-macos-{architecture}.tar.gz'
    with tarfile.open(target, 'w:gz') as archive:
        for name, raw in sorted(files.items()):
            info = tarfile.TarInfo('lianban-archive-desktop/' + name)
            info.mode = 0o755 if name.endswith('.command') else 0o644
            info.size = len(raw)
            archive.addfile(info, io.BytesIO(raw))
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix(target.suffix + '.sha256').write_text(digest + '  ' + target.name + '\n')
    print(json.dumps({'file': str(target), 'sha256': digest, 'bytes': target.stat().st_size}))
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('architecture', choices=('arm64', 'x86_64'))
    parser.add_argument('--output', type=Path, default=ROOT / '.build/macos')
    args = parser.parse_args()
    build(args.architecture, args.output.resolve())
