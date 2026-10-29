from pathlib import Path
from threading import Event
from uuid import uuid4
from unittest.mock import patch
import io
import json
import unittest
from update_notices import NoticeService, normalize_notice, version_key, fetch_notice, FEED_URL, FALLBACK_FEED_URL


def release(version='2026.10.21', **changes):
    return {'version': version, 'title': '新版本', 'notes': '更新说明',
            'published_at': '2026-10-21T08:00:00Z', **changes}


class UpdateNoticeTests(unittest.TestCase):
    def service(self, fetcher=lambda: release(), version='2026.10.20.1'):
        self.now = [1000.0]
        self.path = Path(__file__).parent/'test-data'/('updates-' + uuid4().hex)/'cache.json'
        return NoticeService(version, self.path, fetcher, clock=lambda: self.now[0])

    def finish(self, service):
        service.worker.join(2)
        self.assertFalse(service.worker.is_alive())

    def test_versions_do_not_offer_older_equal_or_textually_smaller_releases(self):
        self.assertLess(version_key('2026.10.20'), version_key('2026.10.20.1'))
        self.assertLess(version_key('2026.10.20.2'), version_key('2026.10.20.10'))
        for value in ('2026.10.20', '2026.10.20.1', '2026.10.19.100'):
            service = self.service(lambda: release(value))
            service.refresh()
            self.finish(service)
            self.assertIsNone(service.snapshot()['notice'])

    def test_remote_links_are_not_trusted_and_plain_text_is_preserved(self):
        value = normalize_notice(release(url='javascript:alert(1)', notes='<img src=x onerror=alert(1)>'))
        self.assertEqual(value['url'], 'https://github.com/x107108/lianban-archive-desktop/releases/tag/v2026.10.21')
        self.assertEqual(value['notes'], '<img src=x onerror=alert(1)>')
        for bad in (None, [], release('../x'), release('2026.02.30'), release('2026.10.21-rc1'),
                    release(title=''), release(notes='x'*5001), release(published_at='2026-10-21')):
            with self.subTest(bad=bad), self.assertRaises((ValueError, TypeError)):
                normalize_notice(bad)

    def test_background_check_deduplicates_concurrent_requests_and_does_not_block(self):
        started, allowed = Event(), Event()
        calls = []
        def fetch():
            calls.append(True)
            started.set()
            allowed.wait(2)
            return release()
        service = self.service(fetch)
        first = service.snapshot()
        self.assertTrue(started.wait(1))
        self.assertTrue(first['checking'])
        for _ in range(10):
            self.assertTrue(service.snapshot(force=True)['checking'])
        allowed.set()
        self.finish(service)
        self.assertEqual(len(calls), 1)
        self.assertEqual(service.snapshot()['notice']['version'], '2026.10.21')

    def test_offline_failure_keeps_last_good_notice_and_retries_after_backoff(self):
        calls = []
        def fetch():
            calls.append(True)
            if len(calls) > 1:
                raise OSError('offline')
            return release()
        service = self.service(fetch)
        service.refresh()
        self.finish(service)
        self.now[0] += 301
        service.refresh()
        self.finish(service)
        state = service.snapshot()
        self.assertTrue(state['unavailable'])
        self.assertEqual(state['notice']['version'], '2026.10.21')
        service.refresh()
        self.assertEqual(len(calls), 2)
        self.now[0] += 61
        service.refresh()
        self.finish(service)
        self.assertEqual(len(calls), 3)

    def test_cache_survives_restart_and_manual_checks_are_throttled(self):
        calls = []
        def fetch():
            calls.append(True)
            return release()
        service = self.service(fetch)
        service.refresh()
        self.finish(service)
        restarted = NoticeService(service.current_version, self.path, fetch, clock=lambda: self.now[0])
        self.assertEqual(restarted.snapshot()['notice']['id'], 'release:2026.10.21')
        self.finish(restarted)
        self.assertEqual(len(calls), 2, 'startup checks immediately even with a recent persistent cache')
        restarted.refresh(force=True)
        self.assertEqual(len(calls), 2)
        self.now[0] += 31
        restarted.refresh(force=True)
        self.finish(restarted)
        self.assertEqual(len(calls), 3)

    def test_public_feed_has_cache_busting_and_no_publisher_authentication(self):
        with patch('update_notices.urllib.request.urlopen', side_effect=[io.BytesIO(json.dumps(release()).encode()), io.BytesIO(json.dumps(release()).encode())]) as opened:
            self.assertEqual(fetch_notice()['version'], '2026.10.21')
        request = opened.call_args_list[0].args[0]
        self.assertTrue(request.full_url.startswith(FEED_URL + '?check='))
        self.assertEqual(request.get_header('Cache-control'), 'no-cache')
        self.assertIsNone(request.get_header('Authorization'))

    def test_successful_but_stale_raw_response_does_not_hide_newer_api_message(self):
        with patch('update_notices.urllib.request.urlopen', side_effect=[
                io.BytesIO(json.dumps(release('2026.10.20')).encode()),
                io.BytesIO(json.dumps(release('2026.10.21')).encode())]):
            self.assertEqual(fetch_notice()['version'], '2026.10.21')

    def test_raw_newer_than_api_is_kept_and_one_failed_source_does_not_discard_a_valid_message(self):
        for other in (io.BytesIO(json.dumps(release('2026.10.20')).encode()), OSError('API unavailable')):
            with patch('update_notices.urllib.request.urlopen', side_effect=[io.BytesIO(json.dumps(release()).encode()), other]):
                self.assertEqual(fetch_notice()['version'], '2026.10.21')

    def test_invalid_notice_schema_in_one_source_uses_valid_other_source(self):
        with patch('update_notices.urllib.request.urlopen', side_effect=[io.BytesIO(b'{"version":"invalid"}'), io.BytesIO(json.dumps(release()).encode())]):
            self.assertEqual(fetch_notice()['version'], '2026.10.21')

    def test_raw_feed_network_failure_or_invalid_json_uses_official_api_fallback(self):
        for failure in (OSError('raw domain unavailable'), io.BytesIO(b'<html>unavailable</html>')):
            with self.subTest(failure=type(failure).__name__), patch('update_notices.urllib.request.urlopen',
                    side_effect=[failure, io.BytesIO(json.dumps(release()).encode())]) as opened:
                self.assertEqual(fetch_notice()['version'], '2026.10.21')
                self.assertTrue(opened.call_args.args[0].full_url.startswith(FALLBACK_FEED_URL + '&check='))
                self.assertEqual(opened.call_args.args[0].get_header('Accept'), 'application/vnd.github.raw+json')

    def test_oversized_responses_and_total_network_failure_are_rejected(self):
        with patch('update_notices.urllib.request.urlopen', side_effect=[io.BytesIO(b'x'*65537), io.BytesIO(b'x'*65537)]):
            with self.assertRaisesRegex(ValueError, 'too large'):
                fetch_notice()
        with patch('update_notices.urllib.request.urlopen', side_effect=OSError('offline')):
            with self.assertRaises(OSError):
                fetch_notice()

    def test_corrupt_or_future_cache_is_not_shown(self):
        for payload in ('broken', json.dumps({'notice': release(), 'checked_at': 9999999})):
            service = self.service()
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(payload)
            restarted = NoticeService(service.current_version, self.path, clock=lambda: self.now[0])
            self.assertIsNone(restarted.notice)
            self.assertIsNone(restarted.checked_at)


if __name__ == '__main__':
    unittest.main()
