"""Dated suspension snapshots, separate from actual closing limit-up events."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
import re
import ssl
import threading
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import database as db

SOURCE = "东方财富 · 停复牌信息"
SOURCE_URL = "https://data.eastmoney.com/tfpxx/"
URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"


def normalize(payload, day):
    """Validate complete pages; only full-session date coverage retains height."""
    if (isinstance(payload, dict) and payload.get("success") is False
            and payload.get("code") == 9201 and payload.get("message") == "返回数据为空"
            and payload.get("result") is None):
        return [], 0, 0
    result = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(result, dict) or payload.get("success") is not True or not isinstance(result.get("data"), list):
        raise ValueError("停复牌来源返回格式异常")
    count, pages = result.get("count"), result.get("pages")
    if not isinstance(count, int) or isinstance(count, bool) or count < 0 or not isinstance(pages, int) or not 1 <= pages <= 10:
        raise ValueError("停复牌分页信息异常")
    if len(result["data"]) > 500 or (pages == 1 and len(result["data"]) != count):
        raise ValueError("停复牌数据未完整返回")
    records, seen = [], set()
    for row in result["data"]:
        code = row.get("SECURITY_CODE")
        if not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code) or code in seen:
            raise ValueError("停复牌证券代码异常或重复")
        suffix = "SH" if code.startswith("6") else "BJ" if code.startswith(("4", "8", "92")) else "SZ"
        if row.get("SECUCODE") != f"{code}.{suffix}":
            raise ValueError("停复牌证券代码与市场不匹配")
        seen.add(code)
        start = datetime.fromisoformat(row["SUSPEND_START_TIME"])
        end = datetime.fromisoformat(row["SUSPEND_END_TIME"]) if row.get("SUSPEND_END_TIME") else None
        resume = datetime.fromisoformat(row["PREDICT_RESUME_DATE"]).date().isoformat() if row.get("PREDICT_RESUME_DATE") else None
        if start.date().isoformat() != str(row.get("SUSPEND_START_DATE", ""))[:10]:
            raise ValueError("停牌起始日期与时间不一致")
        if (end and end < start) or (resume and resume < start.date().isoformat()):
            raise ValueError("停复牌时间先后顺序异常")
        name, reason = row.get("SECURITY_NAME_ABBR"), row.get("SUSPEND_REASON")
        if not isinstance(name, str) or not name.strip() or not isinstance(reason, str):
            raise ValueError("停复牌名称或原因异常")
        # Only an entire suspended session can preserve an earlier board height.
        # The report also returns securities resuming on this date and can
        # include unrelated intraday pauses. Neither can contribute a height.
        full_day = (start <= datetime.fromisoformat(day).replace(hour=9, minute=30)
                    and (end is None or end >= datetime.fromisoformat(day).replace(hour=15))
                    and (resume is None or resume > day))
        records.append({"code": code, "name": name, "start": start.isoformat(),
                        "end": end.isoformat() if end else None, "resume": resume,
                        "reason": reason, "full_day": full_day})
    return records, count, pages


def fetch(day, raw_dir):
    import truststore
    all_records, seen, raw_paths = [], set(), []
    expected = pages = None
    for page in range(1, 11):
        params = {"sortColumns": "SUSPEND_START_DATE,SECURITY_CODE", "sortTypes": "-1,1",
                  "pageSize": 500, "pageNumber": page, "reportName": "RPT_CUSTOM_SUSPEND_DATA_INTERFACE",
                  "columns": "ALL", "source": "WEB", "client": "WEB",
                  "filter": f"(MARKET=\"全部\")(DATETIME='{day}')"}
        request = Request(URL + "?" + urlencode(params), headers={"User-Agent": "Mozilla/5.0", "Referer": SOURCE_URL})
        with urlopen(request, timeout=15, context=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("停复牌来源响应过大")
        raw_dir.mkdir(parents=True, exist_ok=True)
        path = raw_dir / f"suspensions_{day}_{page}_{hashlib.sha256(raw).hexdigest()[:16]}.json"
        if not path.exists():
            path.write_bytes(raw)
        raw_paths.append(str(path))
        records, total, total_pages = normalize(json.loads(raw), day)
        if expected is not None and (total, total_pages) != (expected, pages):
            raise ValueError("停复牌来源分页期间发生变化")
        expected, pages = total, total_pages
        for record in records:
            if record["code"] in seen:
                raise ValueError("停复牌跨页记录重复")
            seen.add(record["code"])
            all_records.append(record)
        if page >= pages:
            break
    if len(all_records) != expected:
        raise ValueError("停复牌来源分页缺失")
    return all_records, raw_paths


def refresh(path, day):
    records, raw_paths = fetch(day, Path(path).resolve().parent / "raw")
    with closing(db.connect(path)) as conn:
        db.save_suspensions(conn, day, records, SOURCE, raw_paths)
    return len(records)


class Refresher:
    def __init__(self, path):
        self.path, self._lock, self._running = path, threading.Lock(), set()
        self._stopped = False
        self._cycle_queue = []
        self._cycle_pending = set()
        self._cycle_running = False

    def stop(self):
        self._stopped = True

    @property
    def cycles_updating(self):
        with self._lock:
            return bool(self._cycle_pending)

    def maybe_refresh_cycles(self, code=None):
        """Check new archive gaps and viewed stocks without blocking page queries."""
        from suspension_history import cycle_gaps
        with self._lock:
            if self._stopped:
                return False
            if code in self._cycle_pending:
                return True
            with closing(db.connect(self.path)) as conn:
                if not cycle_gaps(conn, code=code, latest_only=code is None):
                    return False
            self._cycle_queue.append(code)
            self._cycle_pending.add(code)
            if not self._cycle_running:
                self._cycle_running = True
                threading.Thread(target=self._run_cycles, daemon=True, name="cycle-suspensions").start()
            return True

    def _run_cycles(self):
        from suspension_history import collect
        while True:
            with self._lock:
                if self._stopped or not self._cycle_queue:
                    self._cycle_queue.clear()
                    self._cycle_pending.clear()
                    self._cycle_running = False
                    return
                code = self._cycle_queue.pop(0)
            try:
                collect(self.path, code=code, latest_only=code is None, stopped=lambda: self._stopped)
            except (ValueError, OSError) as exc:
                print(f"历史停牌核验暂未完成：{exc}", flush=True)
            finally:
                with self._lock:
                    self._cycle_pending.discard(code)

    def maybe_refresh(self, day):
        if not day or day > datetime.now(db.TZ).date().isoformat() or self._stopped:
            return
        with self._lock:
            if day in self._running or len(self._running) >= 2:
                return
            with closing(db.connect(self.path)) as conn:
                previous = conn.execute("SELECT * FROM suspension_days WHERE date=?", (day,)).fetchone()
                if previous:
                    age = datetime.now(db.TZ) - datetime.fromisoformat(previous["checked_at"])
                    if previous["status"] != "updating" and age < timedelta(minutes=15 if previous["status"] == "error" else 60):
                        return
                now = db.now_iso()
                with conn:
                    conn.execute("INSERT INTO suspension_days(date,status,checked_at) VALUES (?,'updating',?) "
                                 "ON CONFLICT(date) DO UPDATE SET status='updating',checked_at=excluded.checked_at", (day, now))
            self._running.add(day)
            threading.Thread(target=self._run, args=(day,), daemon=True, name=f"suspensions-{day}").start()

    def _run(self, day):
        try:
            refresh(self.path, day)
        except Exception as exc:
            with closing(db.connect(self.path)) as conn, conn:
                conn.execute("UPDATE suspension_days SET status='error',error=? WHERE date=?", (str(exc), day))
                db.bump_suspension_revision(conn)
        finally:
            with self._lock:
                self._running.discard(day)
