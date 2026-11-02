"""Launch the unchanged local application with per-copy lifecycle management."""
from pathlib import Path
import argparse
import hashlib
import hmac
import io
import json
import os
import secrets
import sys
import threading
from urllib.parse import urlsplit
from http.server import SimpleHTTPRequestHandler
from update_notices import NoticeService

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
PROJECT_KEY = hashlib.sha256(str(ROOT).casefold().encode('utf-8')).hexdigest()

def serve(port, no_updates=False):
    import app
    import published_tags
    published_tags.apply(ROOT/'data/archive.sqlite3')
    published_tags.initialize_catalog(ROOT/'data/archive.sqlite3')
    import shareholder_seed
    shareholder_seed.apply(ROOT/'data/archive.sqlite3')
    session_file = ROOT/'data/desktop-session.json'
    session = {'pid': os.getpid(), 'port': port, 'project_key': PROJECT_KEY,
               'instance_id': secrets.token_hex(16), 'token': secrets.token_hex(32), 'state': 'starting'}
    session_file.write_text(json.dumps(session), encoding='utf-8')
    original_handler = app.Handler
    version = json.loads((ROOT/'VERSION.json').read_text(encoding='utf-8'))['version']
    notices = NoticeService(version, ROOT/'data/update-notice-cache.json')
    notices.refresh()

    class DesktopHandler(original_handler):
        def send_head(self):
            path = urlsplit(self.path).path
            if path in ('/', '/index.html', '/updates.js', '/updates.css', '/migration.js', '/migration.css'):
                filename = 'index.html' if path in ('/', '/index.html') else path[1:]
                raw = (ROOT/'web'/filename).read_bytes()
                if filename == 'index.html':
                    extension = ('<link rel="stylesheet" href="/updates.css?v=' + version + '">'
                                 '<script src="/updates.js?v=' + version + '" defer></script>'
                                 '<link rel="stylesheet" href="/migration.css?v=' + version + '">'
                                 '<script src="/migration.js?v=' + version + '" defer></script>')
                    raw = raw.replace(b'</head>', extension.encode('utf-8') + b'</head>', 1)
                content_type = {'index.html':'text/html', 'updates.js':'text/javascript',
                                'updates.css':'text/css', 'realtime.js':'text/javascript',
                                'migration.js':'text/javascript', 'migration.css':'text/css'}[filename]
                self.send_response(200)
                self.send_header('Content-Type', content_type + '; charset=utf-8')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                return io.BytesIO(raw)
            return super().send_head()

        def do_GET(self):
            parsed = urlsplit(self.path)
            if parsed.path == '/__desktop__/updates':
                return self.reply(notices.snapshot(force=parsed.query == 'check=1'))
            if parsed.path == '/__desktop__/status':
                return self.reply({k:v for k,v in session.items() if k!='token'})
            if parsed.path in ('/updates.js', '/updates.css', '/realtime.js', '/migration.js', '/migration.css'):
                return SimpleHTTPRequestHandler.do_GET(self)
            return super().do_GET()

        def do_POST(self):
            if urlsplit(self.path).path in ('/__desktop__/personal-data/preview', '/__desktop__/personal-data/import'):
                import personal_data
                if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
                    return self.reply({'error': '请选择 JSON 迁移文件。'}, 415)
                origin = self.headers.get('Origin')
                if origin and origin != 'http://' + self.headers.get('Host', ''):
                    return self.reply({'error': '请在本共享版页面操作。'}, 403)
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= personal_data.MAX_BYTES:
                        return self.reply({'error': '迁移文件不能超过 20 MB。'}, 413)
                    data = personal_data.validate(json.loads(self.rfile.read(length)))
                    if self.path.endswith('/preview'):
                        return self.reply(personal_data.summary(data))
                    return self.reply(personal_data.import_data(ROOT/'data/archive.sqlite3', data))
                except (ValueError, TypeError, KeyError, OverflowError) as exc:
                    return self.reply({'error': str(exc) or '迁移文件格式无效。'}, 400)
            if urlsplit(self.path).path == '/__desktop__/shutdown':
                supplied = self.headers.get('X-Desktop-Token', '')
                if not hmac.compare_digest(supplied, session['token']):
                    return self.reply({'error':'Invalid launcher token'}, 403)
                self.reply({'stopping':True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            return super().do_POST()

    app.Handler = DesktopHandler
    class OfflineRefresher:
        def __init__(self, *args, **kwargs): pass
        def maybe_refresh(self, *args, **kwargs): pass
        def start(self): pass
        def stop(self): pass
    # Published labels remain the default; provider refreshes cannot replace them.
    app.concept_tags.Refresher = OfflineRefresher
    if no_updates:
        app.industry.Refresher = OfflineRefresher
        app.registration.Refresher = OfflineRefresher
        app.suspension.Refresher = OfflineRefresher
        app.live_update.Refresher = OfflineRefresher
        app.live_pool.Refresher = OfflineRefresher
        app.shareholders.Refresher = OfflineRefresher
        app.control_owners.Refresher = OfflineRefresher
    sys.argv = [str(ROOT/'app.py'), '--port', str(port), '--db', str(ROOT/'data/archive.sqlite3')]
    session['state'] = 'running'
    session_file.write_text(json.dumps(session), encoding='utf-8')
    try:
        app.main()
    finally:
        session['state'] = 'stopped'
        session_file.write_text(json.dumps(session), encoding='utf-8')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['serve'])
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-updates', action='store_true', help='Offline acceptance testing only')
    options = parser.parse_args()
    serve(options.port, options.no_updates)
