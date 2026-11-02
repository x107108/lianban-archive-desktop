"""Offline installation. Existing personal databases are never overwritten."""
from pathlib import Path, PurePosixPath
import gzip
import hashlib
import importlib.metadata
import json
import sqlite3
import sys
import sysconfig
import zipfile

ROOT = Path(__file__).resolve().parent

def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def verify():
    bundle = json.loads((ROOT/'BUNDLE.json').read_text(encoding='utf-8'))
    for name, expected in bundle['sha256'].items():
        path = (ROOT/name).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file() or sha256(path) != expected:
            raise ValueError('Missing or changed distribution file: ' + name)
    baseline = json.loads((ROOT/'SOURCE_BASELINE.json').read_text(encoding='utf-8'))
    for name, expected in baseline['identity_sha256'].items():
        if sha256(ROOT/name) != expected:
            raise ValueError('Application differs from the source baseline: ' + name)
    return bundle

def wheel_target(name, destination):
    item = PurePosixPath(name)
    if item.is_absolute() or '..' in item.parts or '\\' in name or ':' in name:
        raise ValueError('Unsafe wheel entry')
    parts = item.parts
    base = destination
    if parts and parts[0].endswith('.data'):
        if len(parts) < 3 or parts[1] not in ('purelib', 'platlib', 'scripts', 'data', 'headers'):
            raise ValueError('Unsupported wheel data entry: ' + name)
        if parts[1] in ('scripts', 'data', 'headers'):
            base = (destination.parents[1] / {'scripts':'Scripts','data':'share','headers':'Include'}[parts[1]]
                    if sys.platform == 'win32' else Path(sys.prefix) / {'scripts':'bin','data':'share','headers':'include'}[parts[1]])
        parts = parts[2:]
    result = base.joinpath(*parts).resolve()
    if not result.is_relative_to(base.resolve()):
        raise ValueError('Wheel entry leaves its destination')
    return result

def install():
    bundle = verify()
    destination = (Path(sys.executable).parent/'Lib/site-packages' if sys.platform == 'win32'
                   else Path(sysconfig.get_paths()['purelib']))
    destination.mkdir(parents=True, exist_ok=True)
    for name in bundle['wheels']:
        with zipfile.ZipFile(ROOT/name) as archive:
            for member in archive.infolist():
                if member.is_dir():
                    continue
                path = wheel_target(member.filename, destination)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.read(member))
    for name, expected in bundle['dependencies'].items():
        if importlib.metadata.version(name) != expected:
            raise RuntimeError('Dependency version mismatch: ' + name)
    target = ROOT/'data/archive.sqlite3'
    target.parent.mkdir(exist_ok=True)
    created = False
    if not target.exists():
        raw = gzip.decompress((ROOT/bundle['seed']).read_bytes())
        if hashlib.sha256(raw).hexdigest() != bundle['seed_database_sha256']:
            raise ValueError('Initial database checksum mismatch')
        with target.open('xb') as handle:
            handle.write(raw)
        created = True
    with sqlite3.connect(target.resolve().as_uri()+'?mode=ro', uri=True) as conn:
        if conn.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Database integrity check failed; the file has been retained.')
    print(json.dumps({'installed': True, 'database_created': created,
                      'database_preserved': not created, 'bundle': bundle['id']}))

if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1]=='verify':
        verify()
        print('Application, UI resources, runtime, dependencies and seed verified.')
    else:
        install()
