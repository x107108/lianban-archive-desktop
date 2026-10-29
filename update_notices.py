"""Public release notices; no credentials or personal database access."""
from datetime import date, datetime
from pathlib import Path
import json
import re
import threading
import time
import urllib.request

REPOSITORY = 'https://github.com/x107108/lianban-archive-desktop'
FEED_URL = 'https://raw.githubusercontent.com/x107108/lianban-archive-desktop/main/updates/latest.json'
FALLBACK_FEED_URL = 'https://api.github.com/repos/x107108/lianban-archive-desktop/contents/updates/latest.json?ref=main'
CHECK_INTERVAL = 300
FAILURE_INTERVAL = 60
MANUAL_INTERVAL = 30


def version_key(value):
    if not isinstance(value, str) or not re.fullmatch(r'20[0-9]{2}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]{1,6})?', value):
        raise ValueError('Invalid release version')
    parts = tuple(int(part) for part in value.split('.'))
    date(*parts[:3])
    return (*parts[:3], parts[3] if len(parts) == 4 else 0)


def normalize_notice(value):
    if not isinstance(value, dict):
        raise ValueError('Invalid release notice')
    version = value.get('version')
    version_key(version)
    title, notes, published = (value.get(key) for key in ('title', 'notes', 'published_at'))
    if not isinstance(title, str) or not title.strip() or len(title) > 120:
        raise ValueError('Invalid notice title')
    if not isinstance(notes, str) or len(notes) > 5000:
        raise ValueError('Invalid notice text')
    if not isinstance(published, str) or len(published) > 40:
        raise ValueError('Invalid publication time')
    stamp = datetime.fromisoformat(published.replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        raise ValueError('Publication time needs a timezone')
    return {'id': 'release:' + version, 'version': version, 'title': title.strip(),
            'notes': notes, 'published_at': published,
            'url': REPOSITORY + '/releases/tag/v' + version}


def fetch_notice():
    # Both URLs are public repository data; no credentials or personal records are sent.
    for url in (FEED_URL, FALLBACK_FEED_URL):
        separator = '&' if '?' in url else '?'
        request = urllib.request.Request(url + separator + 'check=' + str(int(time.time())),
            headers={'User-Agent': 'Lianban-Desktop-Update-Notice/2',
                     'Accept': 'application/vnd.github.raw+json', 'Cache-Control': 'no-cache'})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                raw = response.read(65537)
            if len(raw) > 65536:
                raise ValueError('Notice is too large')
            return json.loads(raw)
        except (OSError, ValueError):
            if url == FALLBACK_FEED_URL:
                raise


class NoticeService:
    def __init__(self, current_version, cache_path, fetcher=fetch_notice, clock=time.time):
        version_key(current_version)
        self.current_version = current_version
        self.cache_path = Path(cache_path)
        self.fetcher, self.clock = fetcher, clock
        self.lock = threading.Lock()
        self.worker = None
        self.notice = None
        self.checked_at = None
        self.last_attempt = None
        self.error = False
        try:
            cache = json.loads(self.cache_path.read_text(encoding='utf-8'))
            self.notice = normalize_notice(cache['notice'])
            stamp = cache['checked_at']
            if type(stamp) not in (int, float) or not 0 < stamp <= self.clock():
                raise ValueError('Invalid cache time')
            # Reuse the message immediately, but always check again after starting the app.
            self.checked_at = stamp
        except (OSError, ValueError, KeyError, TypeError):
            self.notice = None

    def refresh(self, force=False):
        with self.lock:
            now = self.clock()
            interval = MANUAL_INTERVAL if force else FAILURE_INTERVAL if self.error else CHECK_INTERVAL
            if self.worker and self.worker.is_alive():
                return
            if self.last_attempt is not None and now - self.last_attempt < interval:
                return
            self.last_attempt = now
            self.worker = threading.Thread(target=self._check, daemon=True)
            self.worker.start()

    def _check(self):
        try:
            notice = normalize_notice(self.fetcher())
            checked_at = self.clock()
            with self.lock:
                self.notice, self.checked_at, self.error = notice, checked_at, False
            try:
                self.cache_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.cache_path.with_suffix('.tmp')
                temporary.write_text(json.dumps({'notice': notice, 'checked_at': checked_at},
                                                ensure_ascii=False), encoding='utf-8')
                temporary.replace(self.cache_path)
            except OSError:
                pass
        except Exception:
            # A failed network check must never interrupt local queries or discard a good notice.
            with self.lock:
                self.error = True

    def snapshot(self, force=False):
        self.refresh(force=force)
        with self.lock:
            checking = bool(self.worker and self.worker.is_alive())
            newer = self.notice and version_key(self.notice['version']) > version_key(self.current_version)
            return {'current_version': self.current_version, 'checking': checking,
                    'checked_at': self.checked_at, 'unavailable': self.error,
                    'notice': dict(self.notice) if newer else None}
