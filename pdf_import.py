"""Extract common text-based 10-day school timetable layouts from a PDF."""

import re
import subprocess
import uuid
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from statistics import median


DAY_RE = re.compile(r"\b(?:day|d)\s*(10|[1-9])\b", re.I)
TIME_RE = re.compile(
    r"(?<!\w)(\d{1,2})[:.](\d{2})\s*(am|pm)?\s*[-–—]\s*"
    r"(\d{1,2})[:.](\d{2})\s*(am|pm)?\b", re.I
)
ROOM_RE = re.compile(r"\b(?:room|rm)\s*[:#-]?\s*([\w-]+)\b", re.I)
DATE_HEADER_RE = re.compile(r"^\d{1,2}\s+[A-Za-z]{3}\s+(?:Mon|Tue|Wed|Thu|Fri)\b", re.I)


def parse_time(match):
    sh, sm, sa, eh, em, ea = match.groups()
    sh, eh = int(sh), int(eh)
    sa, ea = (sa or "").lower(), (ea or "").lower()
    if not sa and ea:
        sa = "am" if ea == "pm" and sh < 12 and (eh == 12 or sh > eh) else ea
    if not ea and sa:
        ea = sa if eh >= sh else ("pm" if sa == "am" else "am")

    def normalize(hour, minute, marker):
        if int(minute) > 59 or hour > 23 or (marker and not 1 <= hour <= 12):
            return None
        if marker:
            hour = hour % 12 + (12 if marker == "pm" else 0)
        elif hour < 7:  # Afternoon school periods often omit AM/PM.
            hour += 12
        return f"{hour:02d}:{minute}"

    start = normalize(sh, sm, sa)
    end = normalize(eh, em, ea)
    if start and end and end <= start and not ea and eh <= 12:
        end = f"{int(end[:2]) + 12:02d}:{em}"
    return (start, end) if start and end and end > start else None


def make_class(day, times, label):
    label = re.sub(r"\s+", " ", label).strip(" -|:;,.")
    if not label or re.fullmatch(r"(?:break|lunch|recess|homeroom)", label, re.I):
        return None
    room_match = ROOM_RE.search(label)
    room = f"Room {room_match.group(1)}" if room_match else ""
    subject = ROOM_RE.sub("", label).strip(" -|:,.")
    if not subject:
        return None
    return {
        "id": uuid.uuid4().hex,
        "day": day,
        "start": times[0],
        "end": times[1],
        "subject": subject[:80],
        "room": room[:40],
        "color": "green",
    }


def parse_timetable_text(text):
    """Recognize day sections, inline rows, and multi-column timetable grids."""
    found = []
    current_day = None
    columns = []
    active_row_time = None
    pending = None

    def flush_pending():
        nonlocal pending
        if pending:
            item = make_class(*pending)
            if item:
                found.append(item)
        pending = None

    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        days = list(DAY_RE.finditer(line))
        time_match = TIME_RE.search(line)
        times = parse_time(time_match) if time_match else None

        if len(days) >= 2 and not time_match:
            flush_pending()
            columns = [(m.start(), f"Day {m.group(1)}") for m in days]
            current_day = None
            active_row_time = None
            continue

        if columns:
            if days and not time_match and len(days) == 1:
                columns = []  # A new day-section starts here.
            else:
                if times:
                    active_row_time = times
                if active_row_time:
                    flush_pending()
                    for index, (start, day) in enumerate(columns):
                        end = columns[index + 1][0] if index + 1 < len(columns) else len(line)
                        cell = line[start:end].strip()
                        if time_match:
                            cell = TIME_RE.sub("", cell).strip()
                        item = make_class(day, active_row_time, cell)
                        if item:
                            found.append(item)
                continue

        if days and times:
            flush_pending()
            current_day = f"Day {days[0].group(1)}"
            label = DAY_RE.sub("", line, count=1)
            label = TIME_RE.sub("", label, count=1)
            pending = (current_day, times, label)
        elif len(days) == 1 and not times:
            flush_pending()
            current_day = f"Day {days[0].group(1)}"
            pending = None
        elif times and current_day:
            flush_pending()
            label = TIME_RE.sub("", line, count=1)
            pending = (current_day, times, label)
        elif pending and current_day and not days:
            # Many PDFs put the subject on the line below its time range.
            day, slot, label = pending
            if len(label) < 30:
                pending = (day, slot, f"{label} {line.strip()}")

    flush_pending()
    unique = {}
    for item in found:
        key = (item["day"], item["start"], item["end"], item["subject"].lower())
        unique.setdefault(key, item)
    return sorted(unique.values(), key=lambda c: (int(c["day"].split()[1]), c["start"], c["subject"]))


def parse_dated_grid(pdf_bytes):
    """Read independent timetable columns using text coordinates, including OCR."""
    result = subprocess.run(
        ["pdftotext", "-bbox-layout", "-", "-"], input=pdf_bytes,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=12, check=False,
    )
    if result.returncode:
        return None
    try:
        root = ET.fromstring(result.stdout)
    except ET.ParseError:
        return None

    found = []
    recognized = False
    for page in root.findall(".//{*}page"):
        blocks = []
        for line in page.findall(".//{*}line"):
            segment = []
            previous_right = None
            for word in line.findall("{*}word"):
                x, y = float(word.get("xMin")), float(word.get("yMin"))
                height = float(word.get("yMax")) - y
                if segment and x - previous_right > max(8, height * 2):
                    blocks.append((segment[0][0], segment[0][1], " ".join(item[2] for item in segment)))
                    segment = []
                segment.append((x, y, word.text or ""))
                previous_right = float(word.get("xMax"))
            if segment:
                blocks.append((segment[0][0], segment[0][1], " ".join(item[2] for item in segment)))

        def is_header(label):
            return DATE_HEADER_RE.match(label) or DAY_RE.fullmatch(label)

        headers = sorted(((x, y, label) for x, y, label in blocks if is_header(label)),
                         key=lambda entry: entry[0])
        if not headers or len(headers) > 10 or len({x for x, _, _ in headers}) != len(headers):
            continue
        if not any(DAY_RE.search(label) for _, _, label in headers):
            continue
        # Small grey day numbers can be lost by OCR. Recover a missing number
        # only when the other printed days agree with the dated column order.
        offsets = {(int(match.group(1)) - index - 1) % 10
                   for index, (_, _, label) in enumerate(headers)
                   if (match := DAY_RE.search(label))}
        inferred_offset = next(iter(offsets)) if len(offsets) == 1 else None
        recognized = True
        boundaries = [headers[index + 1][0] - (headers[index + 1][0] - headers[index][0]) * 0.08
                      for index in range(len(headers) - 1)]
        for index, (header_x, header_y, header) in enumerate(headers):
            day_match = DAY_RE.search(header)
            if day_match:
                day = f"Day {day_match.group(1)}"
            elif inferred_offset is not None and DATE_HEADER_RE.match(header):
                day = f"Day {(inferred_offset + index) % 10 + 1}"
            else:
                continue  # Holidays have no cycle day and no classes.
            left = boundaries[index - 1] if index else 0
            right = boundaries[index] if index < len(boundaries) else float(page.get("width"))
            words = [(float(word.get("xMin")), float(word.get("yMin")),
                      float(word.get("yMax")), word.text or "")
                     for word in page.findall(".//{*}word")
                     if left <= float(word.get("xMin")) < right
                     and float(word.get("yMin")) > header_y + 8]
            line_tolerance = median([bottom - top for _, top, bottom, _ in words]) * 0.5 if words else 1
            lines = []
            for word in sorted(words, key=lambda item: ((item[1] + item[2]) / 2, item[0])):
                center = (word[1] + word[2]) / 2
                if not lines or abs(center - lines[-1][0]) > line_tolerance:
                    lines.append((center, [word]))
                else:
                    lines[-1][1].append(word)
            entries = [(y, " ".join(word[3] for word in sorted(line, key=lambda item: item[0])))
                       for y, line in lines]
            title = None
            for _, label in entries:
                match = TIME_RE.search(label)
                if match:
                    times = parse_time(match)
                    if title and times:
                        item = make_class(day, times, title)
                        if item:
                            found.append(item)
                    title = None
                elif re.search(r"\d{1,2}:\d{2}", label):
                    title = None  # Never attach an unreadable time to the next subject.
                elif not re.match(r"^(?:Public Holiday|PD Day|Dussehra)$", label, re.I):
                    title = f"{title} {label}" if title else label

    if not recognized:
        return None
    unique = {}
    for item in found:
        key = (item["day"], item["start"], item["end"], item["subject"].lower())
        unique.setdefault(key, item)
    return sorted(unique.values(), key=lambda c: (int(c["day"].split()[1]), c["start"], c["subject"]))


def suggest_day_one(pdf_bytes):
    """Infer the cycle anchor from a dated export with printed cycle days."""
    result = subprocess.run(
        ["pdftotext", "-layout", "-f", "1", "-l", "1", "-", "-"],
        input=pdf_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=12, check=False,
    )
    if result.returncode:
        return None
    text = result.stdout.decode("utf-8", errors="replace")
    year = re.search(r"Student Timetable\s*-.*?\b(20\d{2})\b", text)
    if not year:
        return None
    header = re.search(r"\b(\d{1,2})\s+([A-Za-z]{3})\s+(Mon|Tue|Wed|Thu|Fri)\s+Day\s+(10|[1-9])\b", text, re.I)
    if not header:
        return None
    try:
        month = datetime.strptime(header.group(2), "%b").month
        source = date(int(year.group(1)), month, int(header.group(1)))
    except ValueError:
        return None
    if source.strftime("%a").lower() != header.group(3).lower():
        return None
    remaining = int(header.group(4)) - 1
    while remaining:
        source -= timedelta(days=1)
        if source.weekday() < 5:
            remaining -= 1
    return source.isoformat()


def extract_pdf_classes(pdf_bytes):
    if not pdf_bytes.startswith(b"%PDF-"):
        raise ValueError("Choose a valid PDF file.")
    try:
        grid_classes = parse_dated_grid(pdf_bytes)
    except subprocess.TimeoutExpired:
        raise ValueError("This PDF took too long to read. Try a smaller file.") from None
    except FileNotFoundError:
        raise ValueError("PDF reader is not installed on this server (pdftotext).") from None
    if grid_classes is not None:
        return grid_classes
    try:
        result = subprocess.run(
            ["pdftotext", "-layout", "-nopgbrk", "-", "-"],
            input=pdf_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=12, check=False,
        )
    except FileNotFoundError:
        raise ValueError("PDF reader is not installed on this server (pdftotext).") from None
    except subprocess.TimeoutExpired:
        raise ValueError("This PDF took too long to read. Try a smaller file.") from None
    if result.returncode:
        raise ValueError("Could not read this PDF. It may be damaged or password-protected.")
    text = result.stdout.decode("utf-8", errors="replace")
    if not text.strip():
        raise ValueError("This PDF has no selectable text. Scanned images need OCR first.")
    return parse_timetable_text(text)
