"""Per-copy Mac launcher. Uses only the Python supplied in the release."""
from contextlib import closing
from pathlib import Path
import argparse
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
KEY = hashlib.sha256(str(ROOT).casefold().encode('utf-8')).hexdigest()


def session():
    path = ROOT / 'data/desktop-session.json'
    if not path.exists():
        return None
    try:
        recorded = json.loads(path.read_text())
        if recorded['project_key'] != KEY or recorded['state'] == 'stopped':
            return None
        with urlopen(f"http://127.0.0.1:{recorded['port']}/__desktop__/status", timeout=2) as response:
            status = json.load(response)
        if all(status.get(k) == recorded[k] for k in ('project_key', 'instance_id', 'pid')):
            return recorded
    except (OSError, URLError, ValueError, KeyError):
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('install', 'verify', 'start', 'stop'), nargs='?', default='start')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--no-updates', action='store_true')
    options = parser.parse_args()
    current = session()
    if options.action == 'stop':
        if not current:
            print('本共享版已经停止。')
            return
        request = Request(f"http://127.0.0.1:{current['port']}/__desktop__/shutdown", data=b'{}',
                          headers={'X-Desktop-Token': current['token'], 'Content-Type': 'application/json'})
        with urlopen(request, timeout=5):
            pass
        for _ in range(60):
            if not session():
                print('本共享版已停止。')
                return
            time.sleep(.25)
        raise RuntimeError('程序仍在停止中，请稍后重试。')
    import setup_shared
    if options.action == 'verify':
        setup_shared.verify()
        print('程序、页面、运行环境及初始数据校验通过。')
        return
    bundle = json.loads((ROOT / 'BUNDLE.json').read_text())
    marker = ROOT / '.runtime/macos-installed.json'
    if options.action == 'install' or not marker.exists() or json.loads(marker.read_text()).get('bundle') != bundle['id']:
        setup_shared.install()
        marker.write_text(json.dumps({'bundle': bundle['id']}))
    if options.action == 'install':
        print('安装完成。双击“启动连板档案.command”打开网站。')
        return
    if not current:
        port = None
        for candidate in range(options.port, min(65536, options.port + 31)):
            with closing(socket.socket()) as listener:
                try:
                    listener.bind(('127.0.0.1', candidate))
                except OSError:
                    continue
                port = candidate
                break
        if port is None:
            raise RuntimeError('没有可用的本地端口。')
        args = [sys.executable, str(ROOT / 'desktop.py'), 'serve', '--port', str(port)]
        if options.no_updates:
            args.append('--no-updates')
        with (ROOT / 'data/server.log').open('ab') as out, (ROOT / 'data/server-error.log').open('ab') as err:
            process = subprocess.Popen(args, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                       start_new_session=True)
        for _ in range(120):
            current = session()
            if current or process.poll() is not None:
                break
            time.sleep(.25)
        if not current:
            raise RuntimeError('启动失败，请查看 data/server-error.log。')
    address = f"http://127.0.0.1:{current['port']}"
    if not options.no_browser:
        subprocess.run(['/usr/bin/open', address], check=True)
    print('Website ready: ' + address)


if __name__ == '__main__':
    main()
