"""School feed parsing and network-boundary regression checks (no live credentials)."""
import socket
import unittest
from datetime import date
from unittest.mock import patch

import school_calendar as feeds


def calendar(*events):
    return ('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Bellhop tests//EN\r\n' +
            ''.join('BEGIN:VEVENT\r\n' + event.strip().replace('\n', '\r\n') + '\r\nEND:VEVENT\r\n' for event in events) +
            'END:VCALENDAR\r\n').encode()


def event(uid, title, start, end='', extra=''):
    return f'UID:{uid}\nSUMMARY:{title}\nDTSTART{start}\n' + (f'DTEND{end}\n' if end else '') + extra


class SchoolCalendarTests(unittest.TestCase):
    def parse(self, *events):
        return feeds.parse_school_events(calendar(*events), today=date(2026, 11, 3))

    def test_student_holiday_names_and_ordinary_events(self):
        titles = ['SPTM (MYP)', 'SPTMs', 'PTM', 'PTMs (PYP)', 'PD day', 'PD Days',
                  'Professional Development Day', 'Staff development day', 'INSET day',
                  'No School (Yellow Day)', 'School closed', 'Diwali Holiday', 'Winter Break',
                  'School', 'Mathematics assessment', 'Holiday homework', 'PD preparation',
                  'Meeting about PD', 'Vacation planning']
        results = self.parse(*(event(str(i), title, ';VALUE=DATE:20261103', ';VALUE=DATE:20261104')
                               for i, title in enumerate(titles)))
        classified = {item['title']: item['noSchool'] for item in results}
        for title in titles[:13]:
            self.assertTrue(classified[title], title)
        for title in titles[13:]:
            self.assertFalse(classified[title], title)

    def test_all_day_end_is_exclusive(self):
        item = self.parse(event('holiday', 'Diwali Holiday', ';VALUE=DATE:20261101', ';VALUE=DATE:20261104'))[0]
        self.assertEqual(item['start'], '2026-11-01')
        self.assertEqual(item['end'], '2026-11-04')
        self.assertTrue(item['noSchool'])

    def test_actual_school_labels_do_not_match_assignment_vacation_text(self):
        for title in ('Non-Student Day', 'Non Student Day', 'Public Holiday',
                      'SPTM-MYP & DP', 'Diwali Break', 'Spring Break', 'Winter Break'):
            self.assertTrue(feeds.holiday_reason(title), title)
        for title in ('FA- Listening सुट्टीआणि पर्यटन (Vacation and Tourism)',
                      'Special Days', 'Last Day for Students', 'Teachers Day',
                      'OIS Fest', 'First Day of School', 'Faculty Orientation',
                      'Vacation and Tourism'):
            self.assertEqual(feeds.holiday_reason(title), '', title)

    def test_missing_end_is_one_day(self):
        item = self.parse(event('holiday', 'PD day', ';VALUE=DATE:20261103'))[0]
        self.assertEqual(item['end'], '2026-11-04')

    def test_timezone_and_midnight_end(self):
        results = self.parse(
            event('timed', 'PTM', ':20261102T220000Z', ':20261103T030000Z'),
            event('midnight', 'Holiday', ';TZID=Asia/Kolkata:20261104T080000', ';TZID=Asia/Kolkata:20261105T000000'))
        by_title = {item['title']: item for item in results}
        self.assertEqual(by_title['PTM']['start'], '2026-11-03')
        self.assertEqual(by_title['PTM']['end'], '2026-11-04')
        self.assertEqual(by_title['Holiday']['end'], '2026-11-05')

    def test_recurring_exclusion_override_and_cancelled(self):
        results = self.parse(
            event('weekly', 'PD day', ';VALUE=DATE:20261102', ';VALUE=DATE:20261103',
                  'RRULE:FREQ=WEEKLY;COUNT=4\nEXDATE;VALUE=DATE:20261109'),
            event('weekly', 'Moved PTM', ';VALUE=DATE:20261117', ';VALUE=DATE:20261118',
                  'RECURRENCE-ID;VALUE=DATE:20261116'),
            event('weekly', 'Cancelled PD day', ';VALUE=DATE:20261123', ';VALUE=DATE:20261124',
                  'RECURRENCE-ID;VALUE=DATE:20261123\nSTATUS:CANCELLED'))
        self.assertEqual([(item['start'], item['title']) for item in results],
                         [('2026-11-02', 'PD day'), ('2026-11-17', 'Moved PTM')])
        self.assertEqual(len({item['id'] for item in results}), 2)
        self.assertEqual(results, self.parse(
            event('weekly', 'PD day', ';VALUE=DATE:20261102', ';VALUE=DATE:20261103',
                  'RRULE:FREQ=WEEKLY;COUNT=4\nEXDATE;VALUE=DATE:20261109'),
            event('weekly', 'Moved PTM', ';VALUE=DATE:20261117', ';VALUE=DATE:20261118',
                  'RECURRENCE-ID;VALUE=DATE:20261116'),
            event('weekly', 'Cancelled PD day', ';VALUE=DATE:20261123', ';VALUE=DATE:20261124',
                  'RECURRENCE-ID;VALUE=DATE:20261123\nSTATUS:CANCELLED')))

    def test_malformed_and_expensive_calendar(self):
        for content in (b'<html>Sign in</html>', b'not a calendar', b'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:bad'):
            with self.assertRaises(ValueError):
                feeds.parse_school_events(content)
        with self.assertRaisesRegex(ValueError, 'subdaily'):
            self.parse(event('busy', 'PD day', ':20261103T000000Z', ':20261103T010000Z', 'RRULE:FREQ=MINUTELY'))
        self.assertEqual(feeds.parse_school_events(calendar(), today=date(2026, 11, 3)), [])

    def test_old_and_far_future_events_excluded(self):
        results = self.parse(event('old', 'Holiday', ';VALUE=DATE:20200101', ';VALUE=DATE:20200102'),
                             event('future', 'PD day', ';VALUE=DATE:20300101', ';VALUE=DATE:20300102'))
        self.assertEqual(results, [])

    def test_feed_url_validation(self):
        self.assertEqual(feeds.normalize_feed_url('webcal://school.example/calendar.ics?secret=abc'),
                         'https://school.example/calendar.ics?secret=abc')
        for url in ('http://school.example/c.ics', 'https://localhost/c.ics', 'https://127.0.0.1/c.ics',
                    'https://[::1]/c.ics', 'https://user:pass@school.example/c.ics',
                    'https://school.example:8123/c.ics', 'file:///etc/passwd',
                    'https://school.example/c.ics\r\nX-Test: injected', 'https://school.example\\@localhost'):
            with self.assertRaises(ValueError, msg=url):
                feeds.normalize_feed_url(url)

    def test_dns_private_or_mixed_results_are_blocked(self):
        answer = lambda ip: (socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 443))
        for addresses in ([answer('127.0.0.1')], [answer('8.8.8.8'), answer('10.0.0.1')],
                          [answer('224.0.0.1')]):
            with patch.object(feeds.socket, 'getaddrinfo', return_value=addresses), \
                    patch.object(feeds, '_PinnedHTTPSConnection') as connection:
                with self.assertRaises(ValueError):
                    feeds.fetch_calendar('https://calendar.example/private.ics?accessToken=hidden')
                connection.assert_not_called()

    def test_redirects_revalidate_and_do_not_expose_secrets(self):
        class Response:
            status = 302
            def getheader(self, name):
                return 'https://127.0.0.1/admin' if name == 'Location' else None
        class Connection:
            def __init__(self, host, address): pass
            def request(self, *args, **kwargs): pass
            def getresponse(self): return Response()
            def close(self): pass
        with patch.object(feeds, '_public_addresses', return_value=['8.8.8.8']), \
                patch.object(feeds, '_PinnedHTTPSConnection', Connection):
            with self.assertRaises(ValueError) as error:
                feeds.fetch_calendar('https://calendar.example/private.ics?accessToken=hidden')
            self.assertNotIn('hidden', str(error.exception))
            self.assertNotIn('127.0.0.1', str(error.exception))

    def test_fetch_uses_validated_ip_and_checks_calendar_payload(self):
        requests = []
        content = calendar(event('one', 'PTM', ';VALUE=DATE:20261103'))
        class Response:
            status = 200
            def getheader(self, name): return str(len(content)) if name == 'Content-Length' else None
            def read(self, size): return content
        class Connection:
            def __init__(self, host, address): requests.append((host, address))
            def request(self, *args, **kwargs): requests.append(args)
            def getresponse(self): return Response()
            def close(self): pass
        with patch.object(feeds, '_public_addresses', return_value=['8.8.8.8']), \
                patch.object(feeds, '_PinnedHTTPSConnection', Connection):
            self.assertEqual(feeds.fetch_calendar('https://calendar.example/private.ics?token=hidden'), content)
        self.assertEqual(requests[0], ('calendar.example', '8.8.8.8'))
        self.assertEqual(requests[1], ('GET', '/private.ics?token=hidden'))


if __name__ == '__main__':
    unittest.main()
