"""Dated convertible-bond listings, independent of user tags and blacklist."""
from contextlib import closing
from datetime import date
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import hashlib
import json
import re
import ssl

import database as db

SOURCE = "东方财富 · 可转债正股关联"
SOURCE_URL = "https://data.eastmoney.com/xg/xg/?mkt=kzz"
URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
COLUMNS = "SECURITY_CODE,SECUCODE,SECURITY_NAME_ABBR,CONVERT_STOCK_CODE,LISTING_DATE,DELIST_DATE,EXPIRE_DATE"


def iso_day(value, optional=False):
    if value is None and optional:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}(?: 00:00:00)?", value):
        raise ValueError("可转债日期格式异常")
    return date.fromisoformat(value[:10]).isoformat()


def normalize(payload):
    result = payload.get("result") if isinstance(payload, dict) and payload.get("success") is True else None
    if not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise ValueError("可转债来源返回格式异常，保留已有缓存")
    count, pages = result.get("count"), result.get("pages")
    if (type(count) is not int or count < 1 or type(pages) is not int or not 1 <= pages <= 20
            or pages != (count + 499) // 500 or not 1 <= len(result["data"]) <= 500):
        raise ValueError("可转债分页信息异常")
    records = []
    for row in result["data"]:
        if not isinstance(row, dict):
            raise ValueError("可转债记录格式异常")
        code, stock = row.get("SECURITY_CODE"), row.get("CONVERT_STOCK_CODE")
        if (not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code)
                or row.get("SECUCODE") not in (code + ".SH", code + ".SZ", code + ".NQ")
                or not isinstance(stock, str) or not re.fullmatch(r"[0-9]{6}", stock)):
            raise ValueError("可转债或正股证券代码不匹配")
        name = row.get("SECURITY_NAME_ABBR")
        if not isinstance(name, str) or not name.strip() or len(name) > 50:
            raise ValueError("可转债名称异常")
        listed = iso_day(row.get("LISTING_DATE"), optional=True)
        delisted = iso_day(row.get("DELIST_DATE"), optional=True)
        expires = iso_day(row.get("EXPIRE_DATE"))
        if listed and (expires < listed or delisted and delisted < listed):
            raise ValueError("可转债上市、退出日期顺序异常")
        records.append((code, stock, name.strip(), listed, delisted, expires))
    return records, count, pages


def fetch(raw_dir):
    import truststore
    records, seen, raw_paths = [], set(), []
    expected = None
    for page in range(1, 21):
        params = {"reportName": "RPT_BOND_CB_LIST", "columns": COLUMNS, "pageNumber": page, "pageSize": 500,
                  "sortColumns": "SECURITY_CODE", "sortTypes": "1", "source": "WEB", "client": "WEB"}
        request = Request(URL + "?" + urlencode(params), headers={"User-Agent": "Mozilla/5.0", "Referer": SOURCE_URL})
        with urlopen(request, timeout=20, context=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)) as response:
            raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("可转债来源响应过大")
        raw_dir.mkdir(parents=True, exist_ok=True)
        path = raw_dir / f"convertible_bonds_{page}_{hashlib.sha256(raw).hexdigest()[:16]}.json"
        if not path.exists():
            path.write_bytes(raw)
        raw_paths.append(str(path))
        batch, count, pages = normalize(json.loads(raw))
        if expected is not None and count != expected:
            raise ValueError("可转债分页期间总数发生变化")
        expected = count
        if len(batch) != min(500, count - (page - 1) * 500):
            raise ValueError("可转债分页返回不完整")
        for row in batch:
            if row[0] in seen:
                raise ValueError("可转债分页记录重复")
            seen.add(row[0])
        records.extend(batch)
        if page == pages:
            break
    if len(records) != expected:
        raise ValueError("可转债来源分页缺失")
    return records, raw_paths


def refresh(path=db.DEFAULT_DB):
    records, raw_paths = fetch(Path(path).resolve().parent / "raw")
    with closing(db.connect(path)) as conn, conn:
        # Replace only a complete validated public snapshot, never personal data.
        conn.execute("DELETE FROM convertible_bonds")
        conn.executemany("INSERT INTO convertible_bonds VALUES (?,?,?,?,?,?)", records)
        db.set_settings(conn, convertible_bond_status="ok", convertible_bond_fetched_at=db.now_iso(),
                        convertible_bond_source=SOURCE, convertible_bond_source_url=SOURCE_URL,
                        convertible_bond_count=len(records), convertible_bond_raw_paths=raw_paths,
                        convertible_bond_error="")
    return len(records)


if __name__ == "__main__":
    print(f"Updated {refresh()} convertible-bond listings.")
