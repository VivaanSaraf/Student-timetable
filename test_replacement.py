"""Exercise overlap replacement through the API against an isolated database."""

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


class ReplacementTests(unittest.TestCase):
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

    def setUp(self):
        self.client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        status, _ = self.request('/api/signup', {'name': self._testMethodName[:30], 'password': 'temporary-test-password'})
        self.assertEqual(status, 200)

    def request(self, path, data=None, client=None):
        request = urllib.request.Request(self.base + path,
            data=json.dumps(data).encode() if data is not None else None,
            headers={'Content-Type': 'application/json'})
        try:
            response = (client or self.client).open(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def item(self, id, start='09:00', end='10:00', day='Monday', subject=None):
        return {'id': id, 'subject': subject or id, 'day': day, 'start': start,
                'end': end, 'room': 'Room 506', 'color': 'green'}

    def add(self, *items, **options):
        return self.request('/api/classes/add', {'classes': items, **options})

    def saved(self):
        return self.request('/api/classes')[1]['classes']

    def test_replace_multiple_preserves_unrelated(self):
        first, second = self.item('first'), self.item('second', '10:00', '11:00')
        touching, other_day = self.item('touching', '11:00', '12:00'), self.item('other-day', day='Tuesday')
        self.assertEqual(self.add(first, second, touching, other_day)[0], 200)
        incoming = self.item('replacement', '09:30', '11:00')
        status, error = self.add(incoming)
        self.assertEqual(status, 409)
        self.assertTrue(error['canReplace'])
        self.assertEqual({row['id'] for row in error['conflicts']}, {'first', 'second'})
        self.assertEqual(len(self.saved()), 4)
        status, result = self.add(incoming, replaceIds=['first', 'second'])
        self.assertEqual(status, 200)
        self.assertEqual(result['replaced'], 2)
        self.assertEqual({row['id'] for row in self.saved()}, {'replacement', 'touching', 'other-day'})

    def test_stale_confirmation_requires_new_review(self):
        self.add(self.item('first'))
        incoming = self.item('new', '09:30', '11:00')
        self.assertEqual(self.add(incoming)[0], 409)
        self.add(self.item('later', '10:00', '11:00'))
        status, error = self.add(incoming, replaceIds=['first'])
        self.assertEqual(status, 409)
        self.assertEqual({row['id'] for row in error['conflicts']}, {'first', 'later'})
        self.assertEqual({row['id'] for row in self.saved()}, {'first', 'later'})

    def test_replaces_all_legacy_duplicate_rows(self):
        self.add(self.item('first'))
        with storage.database() as db:
            server.save_class(db, self._testMethodName[:30], self.item('duplicate', subject='first'))
        status, error = self.add(self.item('new'))
        self.assertEqual(status, 409)
        self.assertEqual({row['id'] for row in error['conflicts']}, {'first', 'duplicate'})
        self.assertEqual(self.add(self.item('new'), replaceIds=['first', 'duplicate'])[0], 200)
        self.assertEqual([row['id'] for row in self.saved()], ['new'])

    def test_internal_overlap_cannot_replace(self):
        self.add(self.item('saved'))
        status, error = self.add(self.item('a', '09:30', '10:30'), self.item('b', '10:00', '11:00'), replaceIds=['saved'])
        self.assertEqual(status, 409)
        self.assertFalse(error['canReplace'])
        self.assertEqual([row['id'] for row in self.saved()], ['saved'])

    def test_import_replace_and_duplicates(self):
        first = self.item('saved', day='Day 1')
        kept = self.item('kept', '11:00', '12:00', day='Day 1')
        self.request('/api/classes/import-cycle', {'cycleStart': '2026-10-26', 'classes': [first, kept]})
        duplicate = {**kept, 'id': 'duplicate'}
        incoming = self.item('new', '09:30', '10:30', day='Day 1')
        payload = {'cycleStart': '2026-10-26', 'classes': [incoming, duplicate]}
        status, error = self.request('/api/classes/import-cycle', payload)
        self.assertEqual(status, 409)
        self.assertTrue(error['canReplace'])
        status, result = self.request('/api/classes/import-cycle', {**payload, 'replaceIds': ['saved']})
        self.assertEqual(status, 200)
        self.assertEqual((result['imported'], result['skipped'], result['replaced']), (1, 1, 1))
        self.assertEqual({row['id'] for row in self.saved()}, {'new', 'kept'})

    def test_import_internal_overlap_with_existing_duplicate(self):
        first = self.item('saved', day='Day 1')
        self.request('/api/classes/import-cycle', {'cycleStart': '2026-10-26', 'classes': [first]})
        duplicate = {**first, 'id': 'duplicate'}
        incoming = self.item('new', '09:30', '10:30', day='Day 1')
        status, error = self.request('/api/classes/import-cycle', {
            'cycleStart': '2026-10-26', 'classes': [duplicate, incoming], 'replaceIds': ['saved']})
        self.assertEqual(status, 409)
        self.assertFalse(error['canReplace'])
        self.assertEqual([row['id'] for row in self.saved()], ['saved'])

    def test_failed_save_rolls_back_replacement(self):
        self.add(self.item('saved'))
        with patch.object(server, 'save_class', side_effect=ValueError('Save failed')):
            status, _ = self.add(self.item('new'), replaceIds=['saved'])
        self.assertEqual(status, 400)
        self.assertEqual([row['id'] for row in self.saved()], ['saved'])

    def test_replacement_does_not_touch_other_accounts(self):
        self.add(self.item('saved'))
        other = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        self.request('/api/signup', {'name': 'separate-student', 'password': 'temporary-test-password'}, client=other)
        self.request('/api/classes/add', {'classes': [self.item('saved')]}, client=other)
        self.assertEqual(self.add(self.item('new'), replaceIds=['saved'])[0], 200)
        self.assertEqual([row['id'] for row in self.request('/api/classes', client=other)[1]['classes']], ['saved'])

    def test_invalid_confirmation_and_adjacent_class(self):
        self.add(self.item('saved'))
        for invalid in ['saved', True, ['saved', 'saved'], [None]]:
            with self.subTest(invalid=invalid):
                self.assertEqual(self.add(self.item('new'), replaceIds=invalid)[0], 400)
        self.assertEqual(self.add(self.item('new'), replaceIds=['unrelated'])[0], 409)
        self.assertEqual(self.add(self.item('adjacent', '10:00', '11:00'))[0], 200)
        self.assertEqual(len(self.saved()), 2)


if __name__ == '__main__':
    unittest.main()
