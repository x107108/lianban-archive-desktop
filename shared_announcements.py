"""Read formal shared-channel notices; keep read state in this installation."""
from pathlib import Path
import json
import re
import threading
import time
from urllib.request import Request, urlopen

FEED_URL = "https://mylianban.com/api/shared-announcement"


def fetch_feed():
    request = Request(FEED_URL, headers={"Accept": "application/json", "Cache-Control": "no-cache",
                                       "User-Agent": "Lianban-Desktop-Announcements/1"})
    with urlopen(request, timeout=8) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError("公告内容过大")
    value = json.loads(raw)
    notice, history, identities = (value[key] for key in ("announcement", "history", "identities"))
    if (not isinstance(notice, dict) or type(notice.get("enabled")) is not bool
            or not all(isinstance(notice.get(key), str) for key in ("title", "content"))
            or not isinstance(history, list) or not isinstance(identities, list)
            or not all(isinstance(identity, str) and re.fullmatch(r"(?:[0-9a-f]{32}|legacy-[0-9]{1,10})", identity) for identity in identities)
            or not all(isinstance(entry, dict) and all(isinstance(entry.get(key), str) for key in ("version", "date", "content")) for entry in history)):
        raise ValueError("公告格式无效")
    return {"announcement": notice, "history": history, "identities": identities}


class AnnouncementService:
    def __init__(self, path, fetcher=fetch_feed, clock=time.monotonic):
        self.path, self.fetcher, self.clock = Path(path), fetcher, clock
        self.lock = threading.Lock()
        self.running, self.next_check, self.unavailable = False, 0, False
        self.saved = {"seen": [], "feed": None}
        if self.path.exists():
            self.saved = json.loads(self.path.read_text(encoding="utf-8"))

    def refresh(self):
        with self.lock:
            if self.running or self.clock() < self.next_check:
                return
            self.running = True
        threading.Thread(target=self._refresh, daemon=True, name="shared-announcements").start()

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".next")
        temporary.write_text(json.dumps(self.saved, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.path)

    def _refresh(self):
        try:
            feed = self.fetcher()
            with self.lock:
                self.saved["feed"] = feed
                self._save()
                self.unavailable = False
        except (OSError, ValueError, KeyError, TypeError):
            self.unavailable = True
        finally:
            with self.lock:
                self.next_check = self.clock() + (60 if self.unavailable else 300)
                self.running = False

    def snapshot(self, claim=False):
        self.refresh()
        with self.lock:
            feed = self.saved["feed"] or {"announcement": {"enabled": False, "title": "", "content": ""}, "history": [], "identities": []}
            show = claim and any(identity not in self.saved["seen"] for identity in feed["identities"])
            if show:
                self.saved["seen"] = list(dict.fromkeys(self.saved["seen"] + feed["identities"]))
                self._save()
            return {"announcement": feed["announcement"], "history": feed["history"],
                    "show": bool(show), "unavailable": self.unavailable, "checking": self.running,
                    "cached": self.saved["feed"] is not None}
