"""School feed parsing and network-boundary regression checks (no live credentials)."""
import socket
import unittest
from datetime import date
from unittest.mock import patch

import school_calendar as feeds
from icalendar import Calendar, Event


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

    def test_metadata_is_preserved_for_each_timed_task(self):
        descriptions = [
            '\nTask Type: Summative Assessment\nClasses: MYP3 Design 1\n'
            'Description: Criterion C: Creating a solution\nCriterion D: Evaluating\n'
            'Created By: Example Teacher\nView Task: https://school.example/tiny/design',
            'Task Type: Formative Assessment\nClasses: MYP3 Visual Arts 5\n'
            'Description: Colour &amp; composition\u00a0study\nCompare two techniques.\n'
            'Created By: Another Teacher\nView Task: https://school.example/tiny/arts',
        ]
        source = Calendar()
        source.add('version', '2.0')
        for index, description in enumerate(descriptions):
            item = Event()
            item.add('uid', 'task-' + str(index))
            item.add('summary', ['Design assessment', 'Art assessment'][index])
            item.add('dtstart', feeds.datetime(2026, 11, 24, 9, 30 + index * 10,
                                               tzinfo=feeds.ZoneInfo('UTC')))
            item.add('dtend', feeds.datetime(2026, 11, 24, 10, index * 10,
                                             tzinfo=feeds.ZoneInfo('UTC')))
            item.add('description', description)
            source.add_component(item)
        results = feeds.parse_school_events(source.to_ical(), today=date(2026, 11, 3))
        by_title = {item['title']: item for item in results}
        first = by_title['Design assessment']
        self.assertFalse(first['allDay'])
        self.assertEqual(first['startTime'], '15:00')
        self.assertEqual(first['endTime'], '15:30')
        self.assertEqual(first['startDateTime'], '2026-11-24T15:00:00+05:30')
        self.assertEqual(first['endDateTime'], '2026-11-24T15:30:00+05:30')
        self.assertEqual(first['taskType'], 'Summative Assessment')
        self.assertEqual(first['className'], 'MYP3 Design 1')
        self.assertEqual(first['createdBy'], 'Example Teacher')
        self.assertEqual(first['url'], 'https://school.example/tiny/design')
        self.assertEqual(first['taskDescription'], 'Criterion C: Creating a solution\nCriterion D: Evaluating')
        self.assertIn('Task Type: Summative Assessment', first['description'])
        self.assertEqual(first['location'], '')
        self.assertFalse(first['noSchool'])
        second = by_title['Art assessment']
        self.assertEqual(second['startTime'], '15:10')
        self.assertEqual(second['endTime'], '15:40')
        self.assertEqual(second['taskType'], 'Formative Assessment')
        self.assertEqual(second['className'], 'MYP3 Visual Arts 5')
        self.assertEqual(second['createdBy'], 'Another Teacher')
        self.assertEqual(second['url'], 'https://school.example/tiny/arts')
        self.assertEqual(second['taskDescription'], 'Colour & composition study\nCompare two techniques.')

    def test_html_description_becomes_plain_text_and_keeps_task_link(self):
        source = Calendar()
        source.add('version', '2.0')
        item = Event()
        item.add('uid', 'html-task')
        item.add('summary', 'Rich task')
        item.add('dtstart', date(2026, 11, 24))
        item.add('dtend', date(2026, 11, 25))
        item.add('description', '<div><b>Task Type:</b> Summative Assessment</div>'
                 '<p>Classes: Biology &amp; Design</p><div>Description: First paragraph.'
                 '<br/>Second paragraph with &lt;symbols&gt;.</div>'
                 '<div>Created By: Example Teacher</div>'
                 '<div>View Task: <a href="https://school.example/task?id=3&amp;view=student">Open task</a></div>'
                 '<script>alert("unsafe")</script><style>body{display:none}</style>')
        item.add('location', '<b>Room 305</b> &amp; Workshop')
        source.add_component(item)
        parsed = feeds.parse_school_events(source.to_ical(), today=date(2026, 11, 3))[0]
        self.assertTrue(parsed['allDay'])
        self.assertIsNone(parsed['startTime'])
        self.assertIsNone(parsed['endTime'])
        self.assertIsNone(parsed['startDateTime'])
        self.assertIsNone(parsed['endDateTime'])
        self.assertEqual(parsed['end'], '2026-11-25')
        self.assertEqual(parsed['taskType'], 'Summative Assessment')
        self.assertEqual(parsed['className'], 'Biology & Design')
        self.assertEqual(parsed['taskDescription'], 'First paragraph.\nSecond paragraph with <symbols>.')
        self.assertEqual(parsed['url'], 'https://school.example/task?id=3&view=student')
        self.assertEqual(parsed['location'], 'Room 305 & Workshop')
        self.assertNotIn('<b>', parsed['description'])
        self.assertNotIn('alert(', parsed['description'])
        self.assertNotIn('display:none', parsed['description'])

    def test_optional_metadata_and_url_property(self):
        plain = self.parse(event('plain', 'Ordinary event', ';VALUE=DATE:20261103'))[0]
        for key in ('description', 'location', 'url', 'taskType', 'className', 'createdBy', 'taskDescription'):
            self.assertEqual(plain[key], '', key)
        item = self.parse(event('linked', 'Linked event', ':20261103T080000', ':20261103T090000',
                               'DESCRIPTION:Description: Instructions\\nView Task: https://school.example/fallback\n'
                               'URL:https://school.example/primary\nLOCATION:Room 100'))[0]
        self.assertEqual(item['url'], 'https://school.example/primary')
        self.assertEqual(item['location'], 'Room 100')
        self.assertEqual(item['startDateTime'], '2026-11-03T08:00:00+05:30')

    def test_metadata_web_links_are_safe_and_bounded(self):
        for value in ('javascript:alert(1)', 'data:text/html,unsafe', '//school.example/task',
                      'https://teacher:secret@school.example/task', 'https://school.example/\nunsafe',
                      'https://school.example/task\t', 'https://school.example:bad/task',
                      'https://school.example\\@evil.example/task'):
            self.assertEqual(feeds.safe_event_url(value), '', value)
        self.assertEqual(feeds.safe_event_url('http://school.example/task'), 'http://school.example/task')
        self.assertEqual(feeds._description_fields("View Task: javascript:alert('https://school.example/task')")['url'], '')
        source = Calendar()
        item = Event()
        item.add('uid', 'bounded')
        item.add('summary', 'Bounded event')
        item.add('dtstart', date(2026, 11, 24))
        item.add('description', 'x' * 30000)
        item.add('location', 'y' * 2000)
        source.add_component(item)
        parsed = feeds.parse_school_events(source.to_ical(), today=date(2026, 11, 3))[0]
        self.assertEqual(len(parsed['description']), 20000)
        self.assertEqual(len(parsed['location']), 1000)

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
