"""Exercise private school-calendar subscriptions against an isolated database."""

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path
from unittest.mock import patch

import server
import storage


class SchoolCalendarApiTests(unittest.TestCase):
    FEED_URL = 'https://school.example/calendar.ics?accessToken=private-test-token'
    EVENTS = [{'id': 'holiday-1', 'title': 'SPTM (MYP)', 'start': '2026-11-04',
               'end': '2026-11-06', 'noSchool': True, 'reason': 'Student holiday',
               'allDay': True, 'description': '', 'startTime': None, 'endTime': None,
               'startDateTime': None, 'endDateTime': None, 'location': '', 'url': '',
               'taskType': '', 'className': '', 'createdBy': ''}]

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.original_db = storage.DB_PATH, storage.DATABASE_URL
        storage.DB_PATH = Path(cls.temp.name) / 'test.sqlite3'
        storage.DATABASE_URL = ''
        storage.initialize_database()
        cls.httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.base = f'http://127.0.0.1:{cls.httpd.server_port}'
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()
        storage.DB_PATH, storage.DATABASE_URL = cls.original_db
        cls.temp.cleanup()

    @staticmethod
    def client():
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def setUp(self):
        self.student = self.client()
        self.username = self._testMethodName[:30]
        self.assertEqual(self.request('/api/signup', {'name': self.username,
                         'password': 'calendar-test-password'}, self.student)[0], 200)
        self.fetcher = patch.object(server, 'fetch_calendar', return_value=b'calendar')
        self.parser = patch.object(server, 'parse_school_events', return_value=self.EVENTS)
        self.fetch = self.fetcher.start()
        self.parse = self.parser.start()
        self.addCleanup(self.fetcher.stop)
        self.addCleanup(self.parser.stop)

    def request(self, path, data=None, client=None):
        request = urllib.request.Request(self.base + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers={'Content-Type': 'application/json'})
        try:
            response = (client or self.student).open(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def subscribe(self, client=None, **extra):
        return self.request('/api/school-calendar/subscribe', {'url': self.FEED_URL, **extra}, client)

    def state(self, client=None):
        return self.request('/api/school-calendar', client=client)

    def test_subscription_is_private_and_persistent(self):
        status, result = self.subscribe()
        self.assertEqual(status, 200)
        self.assertTrue(result['connected'])
        self.assertEqual(result['events'], self.EVENTS)
        self.assertEqual(result['timezone'], 'Asia/Kolkata')
        self.assertIsInstance(result['lastSynced'], int)
        self.assertIsNone(result['error'])
        self.assertEqual(self.state()[1], result)
        for response in (result, self.state()[1], self.request('/api/classes')[1]):
            self.assertNotIn('private-test-token', json.dumps(response))
            self.assertNotIn('feed_url', response)
        self.fetch.assert_called_once_with(self.FEED_URL)
        self.parse.assert_called_once_with(b'calendar', timezone='Asia/Kolkata')

    def test_authentication_required(self):
        anonymous = self.client()
        self.assertEqual(self.state(anonymous)[0], 401)
        for action in ('subscribe', 'refresh', 'disconnect'):
            self.assertEqual(self.request('/api/school-calendar/' + action,
                             {'url': self.FEED_URL}, anonymous)[0], 401)
        self.fetch.assert_not_called()

    def test_invalid_url_or_timezone_keeps_existing_subscription(self):
        self.subscribe()
        before = self.state()[1]
        for payload in ({'url': 'http://localhost/calendar.ics'},
                        {'url': None},
                        {'url': self.FEED_URL, 'timezone': 'Invalid/School'},
                        {'url': self.FEED_URL, 'timezone': ['Asia/Kolkata']}):
            self.assertEqual(self.request('/api/school-calendar/subscribe', payload)[0], 400)
            self.assertEqual(self.state()[1], before)
        self.assertEqual(self.fetch.call_count, 1)

    def test_failed_replacement_keeps_subscription_and_hides_secret(self):
        self.subscribe()
        before = self.state()[1]
        self.fetch.side_effect = RuntimeError('upstream error at ' + self.FEED_URL)
        status, error = self.subscribe()
        self.assertEqual(status, 400)
        self.assertNotIn('private-test-token', json.dumps(error))
        self.assertEqual(self.state()[1], before)

    def test_parser_failure_keeps_subscription(self):
        self.subscribe()
        before = self.state()[1]
        self.parse.side_effect = ValueError('bad calendar ' + self.FEED_URL)
        self.assertEqual(self.subscribe()[0], 400)
        self.assertEqual(self.state()[1], before)

    def test_refresh_failure_retains_cache_and_last_success(self):
        self.subscribe()
        with storage.database() as db:
            db.execute('UPDATE school_calendars SET synced_at = 123 WHERE username = ?', (self.username,))
            db.commit()
        self.fetch.side_effect = TimeoutError(self.FEED_URL)
        status, result = self.request('/api/school-calendar/refresh', {})
        self.assertEqual(status, 200)
        self.assertTrue(result['connected'])
        self.assertEqual(result['events'], self.EVENTS)
        self.assertEqual(result['lastSynced'], 123)
        self.assertEqual(result['error'], server.CALENDAR_REFRESH_ERROR)
        self.assertNotIn('private-test-token', json.dumps(result))
        self.assertEqual(self.state()[1], result)
        self.assertEqual(self.fetch.call_count, 2)

    def test_stale_get_refreshes_and_fresh_get_uses_cache(self):
        self.subscribe()
        with storage.database() as db:
            db.execute('UPDATE school_calendars SET checked_at = 0 WHERE username = ?', (self.username,))
            db.commit()
        changed = [{**self.EVENTS[0], 'title': 'PD Day'}]
        self.parse.return_value = changed
        self.assertEqual(self.state()[1]['events'], changed)
        self.assertEqual(self.state()[1]['events'], changed)
        self.assertEqual(self.fetch.call_count, 2)

    def test_get_upgrades_legacy_event_details_without_reconnecting(self):
        self.subscribe()
        old_events = [{key: value for key, value in event.items()
                       if key not in ('allDay', 'description')} for event in self.EVENTS]
        with storage.database() as db:
            db.execute('UPDATE school_calendars SET events_json = ? WHERE username = ?',
                       (json.dumps(old_events), self.username))
            db.commit()
        details = [{**self.EVENTS[0], 'description': 'Task Type: Assessment\nClasses: Design',
                    'startTime': '15:00', 'endTime': '15:30', 'allDay': False,
                    'taskType': 'Assessment', 'className': 'Design', 'createdBy': 'Teacher',
                    'url': 'https://share.toddleapp.com/tiny/example'}]
        self.parse.return_value = details
        status, result = self.state()
        self.assertEqual(status, 200)
        self.assertEqual(result['events'], details)
        self.assertTrue(result['connected'])
        self.assertNotIn('private-test-token', json.dumps(result))
        self.assertEqual(self.state()[1]['events'], details)
        self.assertEqual(self.fetch.call_count, 2)

    def test_failed_metadata_upgrade_preserves_cache_and_waits_before_retry(self):
        self.subscribe()
        old_events = [{key: value for key, value in event.items() if key != 'description'}
                      for event in self.EVENTS]
        with storage.database() as db:
            db.execute('UPDATE school_calendars SET events_json = ? WHERE username = ?',
                       (json.dumps(old_events), self.username))
            db.commit()
        self.fetch.side_effect = TimeoutError(self.FEED_URL)
        status, result = self.state()
        self.assertEqual(status, 200)
        self.assertEqual(result['events'], old_events)
        self.assertEqual(result['error'], server.CALENDAR_REFRESH_ERROR)
        self.assertNotIn('private-test-token', json.dumps(result))
        self.assertEqual(self.state()[1], result)
        self.assertEqual(self.fetch.call_count, 2)

        # Once the normal retry interval elapses, try the upgrade again.
        self.fetch.side_effect = None
        with storage.database() as db:
            db.execute('UPDATE school_calendars SET checked_at = 0 WHERE username = ?',
                       (self.username,))
            db.commit()
        retried = self.state()[1]
        self.assertEqual(retried['events'], self.EVENTS)
        self.assertIsNone(retried['error'])
        self.assertEqual(self.fetch.call_count, 3)

    def test_empty_calendar_does_not_trigger_metadata_upgrade(self):
        self.parse.return_value = []
        self.subscribe()
        self.assertEqual(self.state()[1]['events'], [])
        self.assertEqual(self.state()[1]['events'], [])
        self.assertEqual(self.fetch.call_count, 1)

    def test_account_isolation_and_disconnect_preserves_classes(self):
        self.subscribe()
        other = self.client()
        self.assertEqual(self.request('/api/signup', {'name': 'other-' + self.username[:20],
                         'password': 'calendar-test-password'}, other)[0], 200)
        self.assertFalse(self.state(other)[1]['connected'])
        self.assertEqual(self.state(other)[1]['events'], [])
        self.subscribe(other)
        item = {'id': 'class-stays', 'subject': 'Science', 'room': '', 'color': 'green',
                'day': 'Monday', 'start': '09:00', 'end': '10:00'}
        self.assertEqual(self.request('/api/classes/add', {'classes': [item]})[0], 200)
        status, result = self.request('/api/school-calendar/disconnect', {})
        self.assertEqual(status, 200)
        self.assertFalse(result['connected'])
        self.assertEqual(result['events'], [])
        self.assertEqual(self.request('/api/classes')[1]['classes'], [item])
        self.assertTrue(self.state(other)[1]['connected'])

    def test_refresh_does_not_resurrect_disconnected_calendar(self):
        self.subscribe()
        old = server.calendar_snapshot(self.username)

        def disconnect_while_fetching(_):
            with storage.database() as db:
                db.execute('DELETE FROM school_calendars WHERE username = ?', (self.username,))
                db.commit()
            return b'calendar'

        self.fetch.side_effect = disconnect_while_fetching
        self.assertFalse(server.refresh_school_calendar(self.username, old)['connected'])

    def test_refresh_does_not_overwrite_newer_subscription(self):
        self.subscribe()
        old = server.calendar_snapshot(self.username)
        newer_events = [{**self.EVENTS[0], 'title': 'New subscription event'}]

        def replace_while_fetching(_):
            with storage.database() as db:
                db.execute("UPDATE school_calendars SET revision = 'new-revision', events_json = ? "
                           'WHERE username = ?', (json.dumps(newer_events), self.username))
                db.commit()
            return b'old calendar'

        self.fetch.side_effect = replace_while_fetching
        result = server.refresh_school_calendar(self.username, old)
        self.assertEqual(result['events'], newer_events)


if __name__ == '__main__':
    unittest.main()
