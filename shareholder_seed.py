"""Initialize missing public shareholder profiles without replacing an existing cache."""
from contextlib import closing
from pathlib import Path
import gzip
import json

import database as db

RESOURCE = Path(__file__).resolve().parent / 'resources/shareholders.json.gz'


def apply(path, resource=RESOURCE):
    with closing(db.connect(path)) as conn:
        existing = {(row['code'], row['scope']):dict(row) for row in conn.execute('SELECT code,scope,report_date,ratio_checked FROM shareholder_profiles')}
        stocks = {row[0] for row in conn.execute('SELECT code FROM stocks')}
        with gzip.open(resource, 'rt', encoding='utf-8') as handle:
            seed = json.load(handle)
        profiles = [row for row in seed['profiles'] if row['code'] in stocks and (row['code'], row['scope']) not in existing]
        missing = {(row['code'], row['scope']) for row in profiles}
        with conn:
            conn.executemany('INSERT INTO shareholder_profiles(code,scope,report_date,source,fetched_at,ratio_checked) VALUES (?,?,?,?,?,?)',
                [(row['code'], row['scope'], row['report_date'], row['source'], row['fetched_at'],row['ratio_checked']) for row in profiles])
            conn.executemany('INSERT INTO stock_shareholders(code,scope,holder_key,holder_name,holder_type,report_date,holding_ratio) VALUES (?,?,?,?,?,?,?)',
                [(row['code'], row['scope'], row['holder_key'], row['holder_name'], row['holder_type'], row['report_date'],row['holding_ratio'])
                 for row in seed['rows'] if (row['code'], row['scope']) in missing])
            # Enrich legacy caches only when their complete holder set and report match.
            # Newer or different profiles remain owned by the local refresher.
            by_profile = {}
            for row in seed['rows']:
                by_profile.setdefault((row['code'],row['scope']),[]).append(row)
            for profile in seed['profiles']:
                key = profile['code'],profile['scope']
                old = existing.get(key)
                if not old or old['ratio_checked'] or old['report_date'] != profile['report_date']:
                    continue
                records = by_profile.get(key,[])
                keys = {r[0] for r in conn.execute('SELECT holder_key FROM stock_shareholders WHERE code=? AND scope=?',key)}
                if keys != {r['holder_key'] for r in records}:
                    continue
                conn.executemany('UPDATE stock_shareholders SET holding_ratio=? WHERE code=? AND scope=? AND holder_key=?',
                                 [(r['holding_ratio'],*key,r['holder_key']) for r in records])
                conn.execute('UPDATE shareholder_profiles SET ratio_checked=? WHERE code=? AND scope=?',(profile['ratio_checked'],*key))
            controls = {r[0] for r in conn.execute('SELECT code FROM stock_control_profiles')}
            additions = {r['code'] for r in seed['control_profiles'] if r['code'] in stocks and r['code'] not in controls}
            conn.executemany('INSERT INTO stock_control_profiles(code,source,fetched_at) VALUES (?,?,?)',
                             [(r['code'],r['source'],r['fetched_at']) for r in seed['control_profiles'] if r['code'] in additions])
            conn.executemany('INSERT INTO stock_control_owners VALUES (?,?,?,?,?,?,?,?)',
                             [(r['code'],r['kind'],r['holder_key'],r['holder_name'],r['holder_type'],r['via_name'],r['source_url'],r['fetched_at']) for r in seed['control_rows'] if r['code'] in additions])
            conn.executemany('INSERT OR IGNORE INTO subsidiary_profiles(code,disclosure_date,companies_json,source_url,fetched_at,attempted_at) VALUES (?,?,?,?,?,?)',
                             [(r['code'],r['disclosure_date'],r['companies_json'],r['source_url'],r['fetched_at'],r['attempted_at']) for r in seed['subsidiaries'] if r['code'] in stocks])
            if not db.get_settings(conn).get('shareholder_fetched_at'):
                oldest = conn.execute('SELECT MIN(fetched_at) FROM shareholder_profiles').fetchone()[0]
                requested = conn.execute('SELECT COUNT(*) FROM (SELECT code FROM shareholder_profiles GROUP BY code HAVING COUNT(*)=2)').fetchone()[0]
                db.set_settings(conn, shareholder_fetched_at=oldest, shareholder_status='current', shareholder_requested=requested)
        return len(profiles)
