"""Read private iCalendar subscriptions without exposing their access links."""

import hashlib
import http.client
import ipaddress
import re
import socket
import ssl
from datetime import date, datetime, time, timedelta
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from icalendar import Calendar
import recurring_ical_events

MAX_FEED_BYTES = 5 * 1024 * 1024
MAX_EVENTS = 2000
FETCH_TIMEOUT = 12
FETCH_ERROR = 'Could not read that calendar. Check the subscription link and try again.'
MAX_DESCRIPTION = 20000


def _is_public_address(address):
    address = ipaddress.ip_address(address)
    return address.is_global and not address.is_multicast and not address.is_reserved


def normalize_feed_url(url):
    """Accept subscription URLs, with no local or credential-bearing authority."""
    if not isinstance(url, str) or not url.strip() or len(url) > 8192:
        raise ValueError('Enter a valid HTTPS calendar subscription link.')
    url = url.strip()
    if any(ord(char) < 32 or ord(char) == 127 for char in url) or '\\' in url:
        raise ValueError('Enter a valid HTTPS calendar subscription link.')
    if url.lower().startswith('webcal://'):
        url = 'https://' + url[9:]
    try:
        parsed = urlsplit(url)
        host = parsed.hostname
        port = parsed.port
        if (parsed.scheme != 'https' or not host or parsed.username is not None
                or parsed.password is not None or port not in (None, 443)):
            raise ValueError()
        host = host.rstrip('.').encode('idna').decode('ascii').lower()
        if (host == 'localhost' or host.endswith(('.localhost', '.local', '.internal'))
                or '%' in host):
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            if '.' not in host or not re.fullmatch(r'[a-z0-9.-]+', host):
                raise ValueError()
        else:
            if not _is_public_address(address):
                raise ValueError()
        authority = f'[{host}]' if ':' in host else host
        return urlunsplit(('https', authority, parsed.path or '/', parsed.query, ''))
    except (ValueError, UnicodeError):
        raise ValueError('Enter a valid public HTTPS calendar subscription link.') from None


def _public_addresses(host):
    try:
        answers = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        addresses = list(dict.fromkeys(answer[4][0] for answer in answers))
        if not addresses or any(not _is_public_address(address) for address in addresses):
            raise ValueError()
        return addresses
    except (OSError, ValueError):
        raise ValueError('Use a calendar subscription hosted on a public website.') from None


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Resolve once and connect only to a validated IP, retaining hostname TLS."""
    def __init__(self, host, address):
        super().__init__(host, timeout=FETCH_TIMEOUT, context=ssl.create_default_context())
        self._address = address

    def connect(self):
        raw = socket.create_connection((self._address, 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def fetch_calendar(url):
    """Fetch without proxies, implicit redirects, or exposing tokenized URLs."""
    current = normalize_feed_url(url)
    for redirect in range(4):
        parsed = urlsplit(current)
        addresses = _public_addresses(parsed.hostname)
        connection = _PinnedHTTPSConnection(parsed.hostname, addresses[0])
        try:
            target = urlunsplit(('', '', parsed.path or '/', parsed.query, ''))
            connection.request('GET', target, headers={
                'Accept': 'text/calendar, application/octet-stream;q=0.8',
                'User-Agent': 'Bellhop-Calendar/1.0',
                'Accept-Encoding': 'identity',
            })
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if redirect == 3 or not location:
                    raise ValueError(FETCH_ERROR)
                current = normalize_feed_url(urljoin(current, location))
                continue
            if response.status != 200:
                raise ValueError(FETCH_ERROR)
            length = response.getheader('Content-Length')
            if length and (not length.isdigit() or int(length) > MAX_FEED_BYTES):
                raise ValueError('The calendar is too large. Use a feed smaller than 5 MB.')
            content = response.read(MAX_FEED_BYTES + 1)
            if len(content) > MAX_FEED_BYTES:
                raise ValueError('The calendar is too large. Use a feed smaller than 5 MB.')
            if not content.lstrip(b'\xef\xbb\xbf\r\n\t ').upper().startswith(b'BEGIN:VCALENDAR'):
                raise ValueError('That link did not return an iCalendar (.ics) calendar.')
            return content
        except ValueError:
            raise
        except (OSError, http.client.HTTPException, UnicodeError):
            raise ValueError(FETCH_ERROR) from None
        finally:
            connection.close()
    raise ValueError(FETCH_ERROR)


def holiday_reason(title):
    """Only names that explicitly describe students being away suppress classes."""
    value = ' '.join(str(title).split())
    if re.search(r'\b(?:sptms?|ptms?)\b', value, re.I):
        return 'Parent-teacher meeting day — no school for students'
    if re.search(r'\b(?:PD\s+days?|professional\s+development\s+days?|staff\s+development\s+days?|INSET(?:\s+days?)?)\b', value, re.I):
        return 'Staff development day — no school for students'
    if re.search(r'\b(?:no\s+school|school\s+(?:is\s+)?closed|non[- ]?instructional\s+days?|non[- ]?student\s+days?)\b', value, re.I):
        return 'No school for students'
    if re.search(r'\bholidays?\b', value, re.I) and not re.search(
            r'\b(?:homework|assignment|preparation|planning|plans?|projects?|meeting)\b', value, re.I):
        return 'School holiday'
    # "Vacation and Tourism" also occurs in assignment titles; a word match
    # anywhere in SUMMARY would incorrectly remove a student's classes.
    if re.fullmatch(r'(?:(?:school|summer|winter|spring|autumn|fall|diwali|christmas|easter|term)\s+)?vacations?(?:\s*\([^)]*\))?', value, re.I):
        return 'School vacation'
    if re.search(r'\b(?:term|summer|winter|spring|autumn|fall|diwali|christmas|easter|mid[- ]?term)\s+break\b', value, re.I):
        return 'School break'
    return ''


def _event_dates(event, timezone):
    start = event.decoded('DTSTART')
    end = event.decoded('DTEND', None)
    if isinstance(start, datetime):
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone)
        start = start.astimezone(timezone)
        if not isinstance(end, datetime):
            end = start
        elif end.tzinfo is None:
            end = end.replace(tzinfo=timezone)
        end = end.astimezone(timezone)
        first = start.date()
        # An event ending at midnight does not occupy the following date.
        last = end.date() if end.time().replace(tzinfo=None) == time.min else end.date() + timedelta(days=1)
        return first, max(first + timedelta(days=1), last)
    if not isinstance(start, date):
        raise ValueError('Missing event date')
    if not isinstance(end, date) or isinstance(end, datetime) or end <= start:
        end = start + timedelta(days=1)
    return start, end


def safe_event_url(value):
    """A feed may supply links, but only ordinary web links reach the UI."""
    if not isinstance(value, str) or len(value) > 8192:
        return ''
    if any(ord(char) < 32 or ord(char) == 127 for char in value) or '\\' in value:
        return ''
    value = value.strip()
    if not value or any(char.isspace() for char in value):
        return ''
    try:
        parsed = urlsplit(value)
        if (parsed.scheme.lower() not in ('https', 'http') or not parsed.hostname
                or parsed.username is not None or parsed.password is not None):
            return ''
        parsed.port  # Validate a supplied port without changing the task link.
    except ValueError:
        return ''
    return value


class _DescriptionText(HTMLParser):
    """Reduce rich descriptions to text; never fetch or execute feed markup."""
    BLOCK_TAGS = {'p', 'div', 'li', 'tr', 'table', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skipped = 0
        self.anchor = ''

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skipped += 1
            return
        if self.skipped:
            return
        if tag == 'br' or tag in self.BLOCK_TAGS:
            self.parts.append('\n')
        if tag == 'a':
            self.anchor = safe_event_url(dict(attrs).get('href', ''))

    def handle_startendtag(self, tag, attrs):
        if tag not in ('script', 'style'):
            self.handle_starttag(tag, attrs)
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skipped = max(0, self.skipped - 1)
            return
        if self.skipped:
            return
        if tag == 'a' and self.anchor:
            # Preserve hrefs when the clickable text says only "View task".
            if not self.parts or self.anchor not in self.parts[-1]:
                self.parts.append(' ' + self.anchor)
            self.anchor = ''
        if tag in self.BLOCK_TAGS:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.skipped:
            self.parts.append(data)


def _plain_text(value, limit=MAX_DESCRIPTION):
    value = str(value or '')[:limit * 4]
    if re.search(r'<(?:p|div|br|span|strong|em|b|i|a|ul|ol|li|table|tr|td|h[1-6]|script|style)(?:\s|/?>)', value, re.I):
        parser = _DescriptionText()
        parser.feed(value)
        parser.close()
        value = ''.join(parser.parts)
    value = unescape(value).replace('\xa0', ' ').replace('\r\n', '\n').replace('\r', '\n')
    value = re.sub(r'[ \t]+\n', '\n', value)
    value = re.sub(r'\n[ \t]+', '\n', value)
    value = re.sub(r'\n{3,}', '\n\n', value)
    return value.strip()[:limit]


def _description_fields(description):
    # Match only whole labels at the start of lines, keeping e.g. "Criterion D:"
    # and multiline assessment instructions inside the Description field.
    labels = list(re.finditer(
        r'(?im)^[ \t]*(Task[ \t]+Type|Class(?:es)?|Description|Created[ \t]+By|View[ \t]+Task)[ \t]*:[ \t]*',
        description))
    fields = {}
    for index, match in enumerate(labels):
        end = labels[index + 1].start() if index + 1 < len(labels) else len(description)
        key = re.sub(r'\s+', ' ', match.group(1)).lower()
        fields.setdefault(key, description[match.end():end].strip())
    task_url = fields.get('view task', '')
    url = safe_event_url(task_url)
    if not url and not re.match(r'^[a-z][a-z0-9+.-]*:', task_url, re.I):
        match = re.search(r'https?://[^\s<>\"\']+', task_url, re.I)
        if match:
            url = safe_event_url(match.group())
    return {
        'taskType': fields.get('task type', '')[:500],
        'className': (fields.get('classes') or fields.get('class', ''))[:1000],
        'createdBy': fields.get('created by', '')[:500],
        'taskDescription': fields.get('description', '')[:MAX_DESCRIPTION],
        'url': url,
    }


def _event_metadata(event, timezone):
    start = event.decoded('DTSTART')
    end = event.decoded('DTEND', None)
    all_day = not isinstance(start, datetime)
    start_datetime = end_datetime = None
    if not all_day:
        start_datetime = (start if start.tzinfo else start.replace(tzinfo=timezone)).astimezone(timezone)
        if isinstance(end, datetime):
            end_datetime = (end if end.tzinfo else end.replace(tzinfo=timezone)).astimezone(timezone)
    description = _plain_text(event.get('DESCRIPTION', '') or event.get('X-ALT-DESC', ''))
    fields = _description_fields(description)
    fields['url'] = safe_event_url(str(event.get('URL', ''))) or fields['url']
    return {
        'allDay': all_day,
        'startTime': start_datetime.strftime('%H:%M') if start_datetime else None,
        'endTime': end_datetime.strftime('%H:%M') if end_datetime else None,
        'startDateTime': start_datetime.isoformat(timespec='seconds') if start_datetime else None,
        'endDateTime': end_datetime.isoformat(timespec='seconds') if end_datetime else None,
        'description': description,
        'location': _plain_text(event.get('LOCATION', ''), limit=1000),
        **fields,
    }


def parse_school_events(content, timezone='Asia/Kolkata', today=None):
    """Expand a bounded school calendar into date ranges (end is exclusive)."""
    if not isinstance(content, (str, bytes)) or len(content) > MAX_FEED_BYTES:
        raise ValueError('The calendar is too large or is not a valid iCalendar file.')
    try:
        tz = ZoneInfo(timezone)
        reference = today or datetime.now(tz).date()
        if isinstance(reference, datetime):
            reference = reference.date()
        window_start = reference - timedelta(days=370)
        window_end = reference + timedelta(days=550)
        calendar = Calendar.from_ical(content)
        if calendar.name != 'VCALENDAR':
            raise ValueError()
        components = calendar.walk('VEVENT')
        if len(components) > 4000:
            raise ValueError('The calendar contains too many events.')
        # Subdaily recurrence is unsuitable for a day-off feed and can expand enormously.
        for component in components:
            rule = component.get('RRULE')
            if rule and (str(rule.get('FREQ', [''])[0]).upper() in ('SECONDLY', 'MINUTELY', 'HOURLY')
                         or any(len(rule.get(key, [])) > 1 for key in ('BYSECOND', 'BYMINUTE', 'BYHOUR'))):
                raise ValueError('Use a school calendar without subdaily recurring events.')
        query = recurring_ical_events.of(calendar)
        # after() is an ordered lazy iterator, preventing an unbounded recurrence expansion.
        iterator = query.after(datetime.combine(window_start, time.min, tz))
        events = []
        seen = set()
        for component in iterator:
            if str(component.get('STATUS', '')).upper() == 'CANCELLED':
                continue
            first, end = _event_dates(component, tz)
            if first >= window_end:
                break
            if end <= window_start:
                continue
            title = str(component.get('SUMMARY', 'School event')).strip()[:250] or 'School event'
            uid = str(component.get('UID', ''))
            # UID + expanded DTSTART distinguishes instances without storing feed tokens.
            instance = str(component.decoded('DTSTART'))
            identifier = hashlib.sha256((uid + '\0' + instance + '\0' + title).encode()).hexdigest()[:32]
            if identifier in seen:
                continue
            seen.add(identifier)
            reason = holiday_reason(title)
            events.append({'id': identifier, 'title': title,
                           'start': first.isoformat(), 'end': end.isoformat(),
                           'noSchool': bool(reason), 'reason': reason,
                           **_event_metadata(component, tz)})
            if len(events) > MAX_EVENTS:
                raise ValueError('The calendar contains too many events in the current school years.')
        return sorted(events, key=lambda event: (event['start'], event['title'], event['id']))
    except ValueError as error:
        if str(error).startswith(('Use a school calendar', 'The calendar contains')):
            raise
        raise ValueError('Could not read the calendar events. Check that the link provides a valid .ics calendar.') from None
    except Exception:
        raise ValueError('Could not read the calendar events. Check that the link provides a valid .ics calendar.') from None
