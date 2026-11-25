from pathlib import Path
import unittest
from uuid import uuid4

from shared_announcements import AnnouncementService


class SharedAnnouncementTests(unittest.TestCase):
    def setUp(self):
        self.path = Path(__file__).parent / "test-data" / ("notice-" + uuid4().hex) / "announcements.json"
        self.feed = {"announcement": {"title": "共享公告", "content": "正文", "enabled": True},
                     "history": [{"version": "2026.11.25", "date": "2026-11-25", "content": "已发布更新"}],
                     "identities": ["a" * 32, "b" * 32]}

    def service(self, fetcher=None):
        return AnnouncementService(self.path, fetcher=fetcher or (lambda: self.feed), clock=lambda: 10)

    def test_reading_does_not_claim_and_restarts_do_not_repeat(self):
        service = self.service()
        service._refresh()
        self.assertEqual(service.snapshot()["history"], self.feed["history"])
        self.assertTrue(service.snapshot(claim=True)["show"])
        self.assertFalse(self.service().snapshot(claim=True)["show"])

    def test_changed_notice_and_new_update_reappear_once(self):
        service = self.service()
        service._refresh()
        service.snapshot(claim=True)
        self.feed["identities"] = ["a" * 32, "c" * 32]
        service._refresh()
        self.assertTrue(service.snapshot(claim=True)["show"])
        self.assertFalse(service.snapshot(claim=True)["show"])

    def test_offline_keeps_last_text_and_each_installation_is_independent(self):
        service = self.service()
        service._refresh()
        service.snapshot(claim=True)

        def offline():
            raise OSError("offline")

        restarted = self.service(offline)
        restarted._refresh()
        self.assertTrue(restarted.snapshot()["unavailable"])
        self.assertEqual(restarted.snapshot()["announcement"]["title"], "共享公告")
        self.assertFalse(restarted.snapshot(claim=True)["show"])
        other = AnnouncementService(self.path.with_name("other-install.json"), fetcher=lambda: self.feed, clock=lambda: 10)
        other._refresh()
        self.assertTrue(other.snapshot(claim=True)["show"])


if __name__ == "__main__":
    unittest.main()
