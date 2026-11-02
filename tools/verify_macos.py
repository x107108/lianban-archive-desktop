"""Real installed-runtime acceptance; all data stays in an isolated copy."""
from pathlib import Path
import json
import socket
import subprocess
import sys
import time
from urllib.request import urlopen

root = Path(sys.argv[1]).resolve()


def run(action, *args):
    result = subprocess.run([str(root / 'launcher-macos.command'), action, *args], cwd=root, check=True, capture_output=True, text=True)
    print(result.stdout)
    return result.stdout


run('install')
run('verify')
with socket.socket() as occupied:
    occupied.bind(('127.0.0.1', 0))
    occupied.listen()
    requested = occupied.getsockname()[1]
    run('start', '--no-browser', '--no-updates', '--port', str(requested))
    session = json.loads((root / 'data/desktop-session.json').read_text())
    assert session['port'] != requested, 'Must choose another port without killing another application'
    first_pid = session['pid']
    run('start', '--no-browser', '--no-updates')
    assert json.loads((root / 'data/desktop-session.json').read_text())['pid'] == first_pid
address = 'http://127.0.0.1:' + str(session['port'])
def get(path):
    with urlopen(address + path, timeout=60) as response:
        return response.read()
try:
    assert json.loads(get('/__desktop__/status'))['project_key'] == session['project_key']
    version = json.loads((root / 'VERSION.json').read_text())['version']
    assert json.loads(get('/__desktop__/updates'))['current_version'] == version
    meta = json.loads(get('/api/meta'))
    day = json.loads(get('/api/date?date=' + meta['latest_date']))
    assert day['rows']
    assert json.loads(get('/api/stock?code=' + day['rows'][0]['code']))
    assert b'/migration.js' in get('/')
    assert get('/migration.js') and get('/fonts/NotoSansSC-VF.woff2') and get('/images/title-companions.jpg')
    print('MACOS_ACCEPTANCE_OK', sys.platform, session['port'], version, len(day['rows']))
finally:
    run('stop')
run('stop')
