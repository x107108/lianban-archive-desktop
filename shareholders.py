"""Latest disclosed top-ten holders, indexed by full disclosed name."""
from __future__ import annotations

from contextlib import closing
from datetime import date, datetime, timedelta
import gzip
import json
import math
import re
from pathlib import Path
import ssl
import time
import unicodedata
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import database as db
from industry import Refresher as MetadataRefresher
import live_pool
from registration import secucode

SOURCE = "东方财富 · 十大股东及十大流通股东"
URL = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
REPORTS = {"total": "RPT_DMSK_HOLDERS", "float": "RPT_F10_EH_FREEHOLDERS"}
SCOPE_NOTE = "按本地已收录股票最新披露的股东、控股股东、实际控制人及有来源依据的上层股东全名匹配，不代表实时持仓或历史当日持仓；上层股东不等于直接持股，同属一个国资主体不表示一致行动或法律上的关联关系。同名个人不保证为同一人，结算及代持账户不代表同一最终投资者。"
BATCH_SIZE = 100
RELATIONS_SQL = """WITH relations AS (
    SELECT code,scope AS kind,holder_key,holder_name,
           CASE WHEN holder_key='香港中央结算有限公司' THEN '香港中央结算有限公司' ELSE holder_type END AS holder_type,
           report_date,holding_ratio,'' AS via_name,'' AS source_url
    FROM stock_shareholders
    UNION ALL
    SELECT code,kind,holder_key,holder_name,
           CASE WHEN holder_key='香港中央结算有限公司' THEN '香港中央结算有限公司' ELSE holder_type END,
           NULL AS report_date,NULL AS holding_ratio,via_name,source_url
    FROM stock_control_owners
) """


def normalize_rows(payload, requested, today, scope="total"):
    if (isinstance(payload, dict) and payload.get("success") is False
            and payload.get("code") == 9201 and payload.get("message") == "返回数据为空"):
        return [], 0, 0
    result = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or payload.get("success") is not True or not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise ValueError("股东来源返回格式异常")
    pages, count = result.get("pages"), result.get("count")
    if type(pages) is not int or type(count) is not int or pages < 1 or count < 1 or not result["data"]:
        raise ValueError("股东来源分页信息异常")
    records = []
    for row in result["data"]:
        code = row.get("SECURITY_CODE")
        if code not in requested or row.get("SECUCODE") != secucode(code):
            raise ValueError("股东来源证券代码不匹配")
        report_date = date.fromisoformat(str(row.get("END_DATE", ""))[:10]).isoformat()
        notice = row.get("NOTICE_DATE")
        if report_date > today or (notice and date.fromisoformat(str(notice)[:10]).isoformat() > today):
            raise ValueError("股东来源包含尚未披露的未来资料")
        name = row.get("HOLDER_NAME")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("股东名称无效")
        name = name.strip()
        key = " ".join(unicodedata.normalize("NFKC", name).split()).casefold()
        ratio_field = "HOLD_RATIO" if scope == "total" else "FREE_HOLDNUM_RATIO"
        if ratio_field not in row:
            raise ValueError("股东来源持股比例字段缺失")
        ratio = row[ratio_field]
        if ratio is not None:
            if isinstance(ratio, bool):
                raise ValueError("股东持股比例无效")
            ratio = float(ratio)
            if not math.isfinite(ratio) or not 0 <= ratio <= 100:
                raise ValueError("股东持股比例无效")
        records.append({"code": code, "holder_name": name, "holder_key": key,
                        "holder_type": row.get("HOLDER_NEWTYPE") or "未分类", "report_date": report_date,
                        "holding_ratio": ratio})
    return records, pages, count


def fetch_batch(codes, scope, raw_dir):
    import truststore

    quoted = ",".join(f'"{secucode(code)}"' for code in codes)
    today = datetime.now(db.TZ).date().isoformat()
    eligible = f"(END_DATE<='{today}')"
    fields = "SECUCODE,SECURITY_CODE,END_DATE,HOLDER_NAME,HOLDER_NEWTYPE,NOTICE_DATE"
    fields += ",HOLD_RATIO" if scope == "total" else ",FREE_HOLDNUM_RATIO"
    params = {"reportName": REPORTS[scope], "columns": fields,
              "filter": f'(SECUCODE in ({quoted}))(IS_MAX_REPORTDATE="1")' + eligible,
              "pageSize": 1000, "sortColumns": "SECUCODE,END_DATE,HOLDER_NAME", "sortTypes": "1,-1,1",
              "source": "HSF10", "client": "PC"}
    page, pages, count, records, payloads = 1, 1, None, [], []
    while page <= pages:
        params["pageNumber"] = page
        request = Request(URL + "?" + urlencode(params), headers={"User-Agent": "Mozilla/5.0", "Referer": "https://emweb.securities.eastmoney.com/"})
        time.sleep(0.3)
        with urlopen(request, timeout=20, context=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)) as response:
            payload = json.load(response)
        rows, total_pages, total_count = normalize_rows(payload, set(codes), today, scope)
        if count is not None and (total_pages != pages or total_count != count):
            raise ValueError("股东来源分页发生变化，稍后重试")
        pages, count = total_pages, total_count
        records.extend(rows)
        payloads.append(payload)
        page += 1
    if len(records) != count:
        raise ValueError("股东来源分页未完整返回")
    # A real source case (300327, 2026-10-29) marks a future allotment as
    # latest. Recover the most recent eligible snapshot for missing codes.
    for code in sorted(set(codes) - {r["code"] for r in records}):
        params.update(filter=f'(SECUCODE="{secucode(code)}")' + eligible,
                      pageNumber=1, pageSize=100, sortColumns="END_DATE,HOLDER_NAME", sortTypes="-1,1")
        request = Request(URL + "?" + urlencode(params), headers={"User-Agent": "Mozilla/5.0", "Referer": "https://emweb.securities.eastmoney.com/"})
        time.sleep(0.3)
        with urlopen(request, timeout=20, context=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)) as response:
            payload = json.load(response)
        rows, _, total = normalize_rows(payload, {code}, today, scope)
        if rows and total > len(rows) and rows[-1]["report_date"] == rows[0]["report_date"]:
            raise ValueError("最新股东快照未完整返回")
        if rows:
            records.extend(r for r in rows if r["report_date"] == rows[0]["report_date"])
        payloads.append(payload)
    raw_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(db.TZ).strftime("%Y%m%dT%H%M%S%f")
    with gzip.open(raw_dir / f"{scope}_{codes[0]}_{stamp}.json.gz", "wt", encoding="utf-8") as output:
        json.dump(payloads, output, ensure_ascii=False)
    return records


def save_batch(conn, codes, records_by_scope):
    fetched_at = db.now_iso()
    # Both scopes of a batch are fetched before replacing any cached profiles.
    with conn:
        for scope, records in records_by_scope.items():
            latest = {}
            for row in records:
                latest[row["code"]] = max(latest.get(row["code"], ""), row["report_date"])
            for code in codes:
                old = conn.execute("SELECT report_date FROM shareholder_profiles WHERE code=? AND scope=?", (code, scope)).fetchone()
                if old and old[0] and (code not in latest or latest[code] < old[0]):
                    raise ValueError(f"{code} 股东资料缺失或倒退，保留缓存")
                conn.execute("DELETE FROM stock_shareholders WHERE code=? AND scope=?", (code, scope))
                conn.execute("INSERT INTO shareholder_profiles(code,scope,report_date,source,fetched_at,ratio_checked) VALUES (?,?,?,?,?,1) ON CONFLICT(code,scope) DO UPDATE SET "
                             "report_date=excluded.report_date,source=excluded.source,fetched_at=excluded.fetched_at,ratio_checked=1",
                             (code, scope, latest.get(code), SOURCE, fetched_at))
            conn.executemany("INSERT OR IGNORE INTO stock_shareholders(code,scope,holder_key,holder_name,holder_type,report_date,holding_ratio) VALUES (?,?,?,?,?,?,?)",
                [(r["code"], scope, r["holder_key"], r["holder_name"], r["holder_type"], r["report_date"], r.get("holding_ratio"))
                 for r in records if r["report_date"] == latest[r["code"]]])


def refresh(path=db.DEFAULT_DB):
    cutoff = (datetime.now(db.TZ) - timedelta(hours=24)).isoformat(timespec="seconds")
    with closing(db.connect(path)) as conn:
        codes = [r[0] for r in conn.execute("SELECT s.code FROM stocks s LEFT JOIN shareholder_profiles p ON p.code=s.code "
                "GROUP BY s.code HAVING COUNT(p.scope)<2 OR MIN(p.fetched_at)<? OR MIN(p.ratio_checked)=0 ORDER BY s.code", (cutoff,))]
        requested = conn.execute("SELECT COUNT(*) FROM stocks").fetchone()[0]
        db.set_settings(conn, shareholder_status="updating", shareholder_completed=0, shareholder_pending=len(codes))
    for offset in range(0, len(codes), BATCH_SIZE):
        batch = codes[offset:offset + BATCH_SIZE]
        records = {scope: fetch_batch(batch, scope, Path(path).resolve().parent / "shareholders") for scope in REPORTS}
        with closing(db.connect(path)) as conn:
            save_batch(conn, batch, records)
            db.set_settings(conn, shareholder_completed=offset + len(batch), shareholder_pending=len(codes))
        if offset + BATCH_SIZE < len(codes):
            time.sleep(0.3)
    with closing(db.connect(path)) as conn:
        db.set_settings(conn, shareholder_fetched_at=db.now_iso(), shareholder_status="current",
                        shareholder_error=None, shareholder_requested=requested)
    return len(codes)


class Refresher(MetadataRefresher):
    def __init__(self, path):
        super().__init__(path, prefix="shareholder", refresh_callback=refresh)


def today_limit_ups(conn, *, include_live=True, now=None):
    current = (now or datetime.now(db.TZ)).astimezone(db.TZ)
    today = current.date().isoformat()
    confirmed = conn.execute("SELECT fetched_at FROM days WHERE date=? AND status='ok'", (today,)).fetchone()
    pool = live_pool.snapshot(conn, today) if include_live and not confirmed else None
    if confirmed:
        limit_codes = {r[0] for r in conn.execute("SELECT code FROM events WHERE date=?", (today,))}
    else:
        limit_codes = {r["code"] for r in pool["records"]} if pool else set()
    return current, confirmed, pool, limit_codes


def today_alerts(conn, *, include_live=True, now=None):
    current, _, _, codes = today_limit_ups(conn, include_live=include_live, now=now)
    holders, alerts = {}, {}
    if len(codes) > 1:
        placeholders = ",".join("?" for _ in codes)
        for row in conn.execute(RELATIONS_SQL + f"SELECT code,kind,holder_key,holder_type FROM relations WHERE code IN ({placeholders}) "
                                "ORDER BY CASE kind WHEN 'total' THEN 0 WHEN 'float' THEN 1 WHEN 'controller' THEN 2 "
                                "WHEN 'actual_controller' THEN 3 ELSE 4 END", sorted(codes)):
            # Use the same type precedence as the popup, including conflicts
            # between top-ten total and float holder classifications.
            stocks = holders.setdefault(row["holder_key"], {})
            if row["code"] not in stocks or row["kind"] not in REPORTS:
                stocks[row["code"]] = row["holder_type"]
        for stocks in holders.values():
            if len(stocks) < 2:
                continue
            for code in stocks:
                for peer, holder_type in stocks.items():
                    if peer != code:
                        alerts.setdefault(code, set()).add(holder_type)
    # Return all qualifying categories once; each browser applies its own blocks.
    return {"today": current.date().isoformat(),
            "rows": [{"code": code, "types": sorted(types)} for code, types in sorted(alerts.items())]}


def stock_view(conn, code, *, include_live=True, now=None):
    if not re.fullmatch(r"[0-9]{6}", code):
        raise ValueError("请输入六位股票代码")
    current, confirmed, pool, limit_codes = today_limit_ups(conn, include_live=include_live, now=now)
    today = current.date().isoformat()
    stock = conn.execute("SELECT name FROM stocks WHERE code=?", (code,)).fetchone()
    profiles = [dict(r) for r in conn.execute("SELECT scope,report_date,fetched_at FROM shareholder_profiles WHERE code=? ORDER BY scope DESC", (code,))]
    own = {}
    own_holders = {scope: [] for scope in REPORTS}
    for row in conn.execute(RELATIONS_SQL + "SELECT * FROM relations WHERE code=? ORDER BY kind,holder_name", (code,)):
        own.setdefault(row["holder_key"], []).append({"kind": row["kind"], "via_name": row["via_name"], "source_url": row["source_url"]})
        if row["kind"] in REPORTS:
            own_holders[row["kind"]].append({"name": row["holder_name"], "type": row["holder_type"],
                                            "report_date": row["report_date"], "holding_ratio": row["holding_ratio"]})
    for holders in own_holders.values():
        holders.sort(key=lambda holder: (holder["holding_ratio"] is None, -(holder["holding_ratio"] or 0), holder["name"]))
    controls = [dict(r) for r in conn.execute("SELECT kind,holder_name AS name,holder_type AS type,via_name,source_url,fetched_at "
                                            "FROM stock_control_owners WHERE code=? ORDER BY CASE kind WHEN 'controller' THEN 0 "
                                            "WHEN 'actual_controller' THEN 1 ELSE 2 END", (code,))]
    settings = db.get_settings(conn)
    peers = {}
    placeholders = ",".join("?" for _ in own)
    matches = conn.execute(RELATIONS_SQL + "SELECT p.*,s.name FROM relations p JOIN stocks s ON s.code=p.code "
        f"WHERE p.code<>? AND p.holder_key IN ({placeholders}) "
        "ORDER BY CASE p.kind WHEN 'total' THEN 0 WHEN 'float' THEN 1 WHEN 'controller' THEN 2 "
        "WHEN 'actual_controller' THEN 3 ELSE 4 END", (code, *own))
    for row in matches:
        peer = peers.setdefault(row["code"], {"code": row["code"], "name": row["name"], "holders": {},
                    "today_together": code in limit_codes and row["code"] in limit_codes})
        holder = peer["holders"].setdefault(row["holder_key"], {"name": row["holder_name"], "type": row["holder_type"],
                           "reports": [], "relations": [], "own_relations": own[row["holder_key"]]})
        if row["kind"] in REPORTS:
            holder["reports"].append({"scope": row["kind"], "date": row["report_date"]})
        else:
            holder["type"] = row["holder_type"]
            holder["relations"].append({"kind": row["kind"], "via_name": row["via_name"], "source_url": row["source_url"]})
    rows = []
    for peer in peers.values():
        peer["holders"] = sorted(peer["holders"].values(), key=lambda h: h["name"])
        peer["shared_count"] = len(peer["holders"])
        rows.append(peer)
    rows.sort(key=lambda p: (not p["today_together"], -p["shared_count"], p["code"]))
    return {"code": code, "name": stock["name"] if stock else code, "profiles": profiles,
            "own_holders": own_holders, "rows": rows, "total": len(rows), "control_owners": controls,
            "control_status": settings.get("control_owner_status", "empty"),
            "control_checked": conn.execute("SELECT 1 FROM stock_control_profiles WHERE code=?", (code,)).fetchone() is not None,
            "control_coverage": conn.execute("SELECT COUNT(DISTINCT code) FROM stock_control_owners").fetchone()[0],
            "status": settings.get("shareholder_status", "empty"), "source": SOURCE, "scope_note": SCOPE_NOTE,
            "today": today, "today_status": "confirmed" if confirmed else "provisional" if pool else "unavailable",
            "today_fetched_at": confirmed[0] if confirmed else pool["fetched_at"] if pool else None,
            "today_stale": bool(pool and current - datetime.fromisoformat(pool["fetched_at"]) > timedelta(minutes=3)),
            "coverage": conn.execute("SELECT COUNT(DISTINCT code) FROM stock_shareholders").fetchone()[0],
            "requested": conn.execute("SELECT COUNT(*) FROM stocks").fetchone()[0]}


if __name__ == "__main__":
    print(f"Updated {refresh()} shareholder profiles.")
