"""Current disclosed controllers and explicitly sourced parent ownership."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timedelta
import gzip
import json
from pathlib import Path
import re
import ssl
import time
import unicodedata
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import database as db
from industry import Refresher as MetadataRefresher
from registration import secucode

SOURCE = "东方财富 · 公司资料（控股股东及实际控制人）"
URL = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
FIELDS = "SECUCODE,SECURITY_CODE,CONTROL_HOLDER,CONTROL_HOLDER_CODE,REAL_CONTROLER,REAL_CONTROLER_CODE"
BATCH_SIZE = 150
PARENT_OWNER_VIA = "青岛华通国有资本投资运营集团有限公司"
PARENT_OWNER_NAME = "青岛市人民政府国有资产监督管理委员会"
PARENT_OWNER_URL = "https://www.chinamoney.org.cn/dqs/cm-s-notice-query/fileDownLoad.do?contentId=3351993&mode=save&priority=0"
# The issuer's disclosure establishes the existing 100% parent ownership.
# Apply this edge only while the current company source still names Huatong.
# This does not treat its proposed share transfer as completed.
EMPTY_NAMES = {"", "无", "暂无", "暂无数据", "不适用", "--", "-", "无控股股东", "无实际控制人", "无实际控制", "无最终控制人"}


def normalize_page(payload, requested):
    if (isinstance(payload, dict) and payload.get("success") is False and payload.get("code") == 9201
            and payload.get("result") is None and payload.get("message") == "返回数据为空"):
        return [], set(), 0, 0
    result = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or payload.get("success") is not True or not isinstance(result, dict) or not isinstance(result.get("data"), list):
        raise ValueError("控股资料来源返回格式异常")
    pages, count = result.get("pages"), result.get("count")
    if type(pages) is not int or type(count) is not int or pages < 1 or count < 1 or not result["data"]:
        raise ValueError("控股资料来源分页信息异常")
    seen, records = set(), []
    for row in result["data"]:
        code = row.get("SECURITY_CODE") if isinstance(row, dict) else None
        if code not in requested or row.get("SECUCODE") != secucode(code) or code in seen:
            raise ValueError("控股资料来源存在重复或不匹配的证券代码")
        if any(field not in row for field in FIELDS.split(",")):
            raise ValueError("控股资料来源主体字段缺失")
        seen.add(code)
        source_url = "https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/Index?" + urlencode(
            {"type": "web", "code": secucode(code)[7:] + code})
        has_parent = False
        for kind, name_field, id_field in [("controller", "CONTROL_HOLDER", "CONTROL_HOLDER_CODE"),
                                          ("actual_controller", "REAL_CONTROLER", "REAL_CONTROLER_CODE")]:
            name_value, id_value = row.get(name_field), row.get(id_field)
            if (name_value is not None and not isinstance(name_value, str)) or (id_value is not None and not isinstance(id_value, str)):
                raise ValueError("控股资料主体字段无效")
            # The source uses both ideographic and ASCII commas between names.
            # Parenthesized company qualifiers may themselves contain commas.
            groups = []
            for value in (name_value or "", id_value or ""):
                parts, current, depth = [], [], 0
                separators = "、" if "、" in value else ",，;；"
                for char in value:
                    if char in "(（":
                        depth += 1
                    elif char in ")）":
                        depth = max(0, depth - 1)
                    if not depth and char in separators:
                        parts.append("".join(current).strip())
                        current = []
                    else:
                        current.append(char)
                parts.append("".join(current).strip())
                groups.append(parts)
            names, identifiers = groups
            if name_value and len(identifiers) == 1 and identifiers[0].isdigit() and "、" not in name_value:
                # 000930 discloses one institution as "COFCO ... Co., Ltd.".
                # A single institution identifier establishes that comma as part of its name.
                names = [name_value.strip()]
            if name_value and id_value and len(names) != len(identifiers):
                raise ValueError(f"{code} 控股资料主体名称与标识数量不符")
            for index, name in enumerate(names):
                if name in EMPTY_NAMES:
                    continue
                identifier = identifiers[index] if id_value else ""
                key = " ".join(unicodedata.normalize("NFKC", name).split()).casefold()
                if re.search(r"国资委|人民政府|国务院|财政[部厅局]|国有资产监督管理|国有资产管理委员会|(?:开发区|高新区|产业园区|经济区|新区)管理委员会", name):
                    holder_type = "国资"
                elif identifier.isdigit():
                    holder_type = "控股机构"
                elif identifier == name:
                    holder_type = "个人"
                else:
                    holder_type = "控股主体"
                records.append({"code": code, "kind": kind, "holder_key": key, "holder_name": name,
                                "holder_type": holder_type, "via_name": "", "source_url": source_url})
                has_parent |= name == PARENT_OWNER_VIA
        if has_parent:
            records.append({"code": code, "kind": "parent_owner", "holder_key": PARENT_OWNER_NAME,
                            "holder_name": PARENT_OWNER_NAME, "holder_type": "国资", "via_name": PARENT_OWNER_VIA,
                            "source_url": PARENT_OWNER_URL})
    return records, seen, pages, count


def fetch_batch(codes, raw_dir):
    import truststore

    quoted = ",".join(f'"{secucode(code)}"' for code in codes)
    params = {"reportName": "RPT_F10_ORG_BASICINFO", "columns": FIELDS,
              "filter": f"(SECUCODE in ({quoted}))", "source": "HSF10", "client": "PC",
              "pageSize": 1000, "sortColumns": "SECUCODE", "sortTypes": "1"}
    page, pages, count, records, available, payloads = 1, 1, None, [], set(), []
    while page <= pages:
        params["pageNumber"] = page
        request = Request(URL + "?" + urlencode(params), headers={"User-Agent": "Mozilla/5.0", "Referer": "https://emweb.securities.eastmoney.com/"})
        time.sleep(0.3)
        with urlopen(request, timeout=20, context=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)) as response:
            payload = json.load(response)
        rows, found, total_pages, total_count = normalize_page(payload, set(codes))
        if count is not None and (pages != total_pages or count != total_count):
            raise ValueError("控股资料来源分页发生变化，稍后重试")
        if available & found:
            raise ValueError("控股资料来源分页包含重复证券")
        pages, count = total_pages, total_count
        records.extend(rows)
        available.update(found)
        payloads.append(payload)
        page += 1
    if len(available) != count:
        raise ValueError("控股资料来源分页未完整返回")
    raw_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(db.TZ).strftime("%Y%m%dT%H%M%S%f")
    with gzip.open(raw_dir / f"{codes[0]}_{stamp}.json.gz", "wt", encoding="utf-8") as output:
        json.dump(payloads, output, ensure_ascii=False)
    return records, available


def save_batch(conn, codes, records, available_codes):
    fetched_at = db.now_iso()
    with conn:
        for code in codes:
            old = conn.execute("SELECT source FROM stock_control_profiles WHERE code=?", (code,)).fetchone()
            if old and old[0] and code not in available_codes:
                raise ValueError(f"{code} 控股资料缺失，保留缓存")
            conn.execute("DELETE FROM stock_control_owners WHERE code=?", (code,))
            conn.execute("INSERT INTO stock_control_profiles VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET "
                         "source=excluded.source,fetched_at=excluded.fetched_at",
                         (code, SOURCE if code in available_codes else "", fetched_at))
        conn.executemany("INSERT OR IGNORE INTO stock_control_owners VALUES (?,?,?,?,?,?,?,?)",
                         [(r["code"], r["kind"], r["holder_key"], r["holder_name"], r["holder_type"], r["via_name"],
                           r["source_url"], fetched_at) for r in records])


def refresh(path=db.DEFAULT_DB):
    cutoff = (datetime.now(db.TZ) - timedelta(hours=24)).isoformat(timespec="seconds")
    with closing(db.connect(path)) as conn:
        codes = [r[0] for r in conn.execute("SELECT s.code FROM stocks s LEFT JOIN stock_control_profiles p ON p.code=s.code "
                "WHERE p.code IS NULL OR p.fetched_at<? ORDER BY p.fetched_at,s.code", (cutoff,))]
        requested = conn.execute("SELECT COUNT(*) FROM stocks").fetchone()[0]
        db.set_settings(conn, control_owner_status="updating", control_owner_completed=0, control_owner_pending=len(codes))
    for offset in range(0, len(codes), BATCH_SIZE):
        batch = codes[offset:offset + BATCH_SIZE]
        records, available = fetch_batch(batch, Path(path).resolve().parent / "control_owners")
        with closing(db.connect(path)) as conn:
            save_batch(conn, batch, records, available)
            db.set_settings(conn, control_owner_completed=offset + len(batch))
    with closing(db.connect(path)) as conn:
        db.set_settings(conn, control_owner_fetched_at=db.now_iso(), control_owner_status="current",
                        control_owner_error=None, control_owner_requested=requested)
    return len(codes)


class Refresher(MetadataRefresher):
    def __init__(self, path):
        super().__init__(path, prefix="control_owner", refresh_callback=refresh)


if __name__ == "__main__":
    print(f"Updated {refresh()} current control profiles.")
