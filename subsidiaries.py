"""Disclosed subsidiaries and business descriptions, cached on first view."""
from __future__ import annotations

from contextlib import closing
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
import json
import re
import ssl
from urllib.error import URLError
from urllib.request import Request, urlopen

import database as db

SOURCE = "同花顺 F10 · 参股控股公司"


class CompanyTable(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.in_title = False
        self.in_caption = False
        self.cell = None
        self.title = ""
        self.caption = ""
        self.rows = []
        self.row = []

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self.in_title = True
        if tag == "table" and dict(attrs).get("id") == "ckg_table":
            self.active = True
        if not self.active:
            return
        if tag == "caption":
            self.in_caption = True
        elif tag == "tr":
            self.row = []
        elif tag in ("td", "th"):
            self.cell = ""

    def handle_data(self, text):
        if self.in_title:
            self.title += text
        if self.in_caption:
            self.caption += text
        if self.cell is not None:
            self.cell += text

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if not self.active:
            return
        if tag == "caption":
            self.in_caption = False
        elif tag in ("td", "th") and self.cell is not None:
            self.row.append(" ".join(self.cell.split()))
            self.cell = None
        elif tag == "tr":
            self.rows.append(self.row)
        elif tag == "table":
            self.active = False


def normalize_html(html, code, today):
    table = CompanyTable()
    table.feed(html)
    if f"({code})" not in table.title:
        raise ValueError("子公司资料证券代码不匹配")
    count = re.search(r"参股或控股公司：\s*(\d+)\s*家", table.caption)
    announcement = re.search(r"最新公告日期：\s*(\d{4}-\d{2}-\d{2})", table.caption)
    if not count or not table.rows or table.rows[0] != ["序号", "关联公司名称", "参控关系", "参控比例", "投资金额(元)", "被参控公司净利润(元)", "是否报表合并", "被参股公司主营业务"]:
        raise ValueError("子公司资料来源表格格式异常")
    disclosure_date = date.fromisoformat(announcement[1]).isoformat() if announcement else None
    if disclosure_date and disclosure_date > today:
        raise ValueError("子公司资料包含未来公告")
    rows = [r for r in table.rows[1:] if len(r) == 8]
    if len(rows) != int(count[1]):
        raise ValueError("子公司资料名单未完整返回")
    companies = []
    for row in rows:
        _, name, relation, ratio, _, _, _, business = row
        if relation not in ("子公司", "孙公司", "控股子公司", "全资子公司"):
            continue
        if not name:
            raise ValueError("子公司名称缺失")
        companies.append({"name": name, "relation": relation,
                          "holding_ratio": ratio if re.fullmatch(r"\d+(?:\.\d+)?%", ratio) else "",
                          "business": business if business not in ("-", "--", "未披露") else ""})
    return disclosure_date, companies


def fetch(code):
    import truststore

    url = f"https://basic.10jqka.com.cn/{code}/company.html"
    request = Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://basic.10jqka.com.cn/"})
    with urlopen(request, timeout=20, context=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)) as response:
        html = response.read().decode("gb18030")
    return normalize_html(html, code, datetime.now(db.TZ).date().isoformat())


def stock_view(path, code, *, refresh=True, now=None):
    if not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请输入六位股票代码")
    current = now or datetime.now(db.TZ)
    stamp = current.isoformat(timespec="seconds")
    with closing(db.connect(path)) as conn:
        stock = conn.execute("SELECT name FROM stocks WHERE code=?", (code,)).fetchone()
        if not stock:
            raise ValueError("未找到该股票")
        profile = conn.execute("SELECT * FROM subsidiary_profiles WHERE code=?", (code,)).fetchone()
    stale = not profile or not profile["fetched_at"] or current - datetime.fromisoformat(profile["fetched_at"]) >= timedelta(hours=24)
    retry_due = not profile or not profile["error"] or current - datetime.fromisoformat(profile["attempted_at"]) >= timedelta(minutes=15)
    if refresh and stale and retry_due:
        try:
            disclosure_date, companies = fetch(code)
            if profile and profile["disclosure_date"] and (not disclosure_date or disclosure_date < profile["disclosure_date"]):
                raise ValueError("子公司资料公告日期倒退，保留缓存")
        except (URLError, TimeoutError, UnicodeError, ValueError) as exc:
            with closing(db.connect(path)) as conn, conn:
                conn.execute("INSERT INTO subsidiary_profiles(code,attempted_at,error) VALUES (?,?,?) "
                             "ON CONFLICT(code) DO UPDATE SET attempted_at=excluded.attempted_at,error=excluded.error",
                             (code, stamp, str(exc)))
        else:
            with closing(db.connect(path)) as conn, conn:
                conn.execute("INSERT INTO subsidiary_profiles VALUES (?,?,?,?,?,?,'') ON CONFLICT(code) DO UPDATE SET "
                             "disclosure_date=excluded.disclosure_date,companies_json=excluded.companies_json,"
                             "source_url=excluded.source_url,fetched_at=excluded.fetched_at,attempted_at=excluded.attempted_at,error=''",
                             (code, disclosure_date, json.dumps(companies, ensure_ascii=False),
                              f"https://basic.10jqka.com.cn/{code}/company.html", stamp, stamp))
        with closing(db.connect(path)) as conn:
            profile = conn.execute("SELECT * FROM subsidiary_profiles WHERE code=?", (code,)).fetchone()
    return {"code": code, "name": stock["name"], "source": SOURCE,
            "status": "error" if profile and profile["error"] else "current" if profile else "empty",
            "disclosure_date": profile["disclosure_date"] if profile else None,
            "fetched_at": profile["fetched_at"] if profile else None,
            "source_url": profile["source_url"] if profile else "",
            "rows": json.loads(profile["companies_json"] or "[]") if profile else []}
