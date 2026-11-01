"""Bellhop's local web server and shared account/timetable database."""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from datetime import date
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from pdf_import import extract_pdf_classes, suggest_day_one
from storage import database, initialize_database, INTEGRITY_ERRORS


ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", os.environ.get("BELLHOP_PORT", "8123")))
HOST = os.environ.get("BELLHOP_HOST", "127.0.0.1")
SECURE_COOKIES = os.environ.get("BELLHOP_SECURE_COOKIES", "0") == "1"
ALLOWED_ORIGINS = {value.strip().rstrip("/") for value in
                   os.environ.get("BELLHOP_ALLOWED_ORIGINS", "").split(",") if value.strip()}
WEEK_DAYS = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"}
CYCLE_DAYS = {f"Day {n}" for n in range(1, 11)}
DAYS = WEEK_DAYS | CYCLE_DAYS
COLORS = {"green", "red", "white"}
SESSION_SECONDS = 12 * 60 * 60
PUBLIC_FILES = {
    "index.html", "timetable.html", "login.html", "style.css", "landing.css",
    "login.css", "script.js", "landing.js", "login.js", "session-ui.js",
}


def validate_cycle_start(value):
    try:
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError()
        chosen = date.fromisoformat(value)
        if chosen.weekday() >= 5:
            raise ValueError()
        return value
    except ValueError:
        raise ValueError("Choose a school day (Monday–Friday) for Day 1.") from None


def validate_class(item):
    if not isinstance(item, dict):
        raise ValueError("Invalid class")
    result = {}
    for key, limit in (("id", 80), ("subject", 80), ("room", 40)):
        value = item.get(key, "" if key == "room" else None)
        if not isinstance(value, str) or len(value) > limit or (key != "room" and not value.strip()):
            raise ValueError("Invalid class")
        result[key] = value.strip()
    if item.get("day") not in DAYS or item.get("color") not in COLORS:
        raise ValueError("Invalid day or colour")
    result["day"] = item["day"]
    result["color"] = item["color"]
    for key in ("start", "end"):
        value = item.get(key)
        if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
            raise ValueError("Invalid time")
        result[key] = value
    if result["end"] <= result["start"]:
        raise ValueError("End time must be later than start time")
    return result


def save_class(db, username, item):
    db.execute(
        "INSERT INTO classes VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (username, id) DO UPDATE SET subject = excluded.subject, day = excluded.day, start = excluded.start, end = excluded.end, room = excluded.room, color = excluded.color",
        (username, item["id"], item["subject"], item["day"], item["start"],
         item["end"], item["room"], item["color"]),
    )


def class_key(item):
    return (item["day"], item["start"], item["end"], item["subject"], item["room"])


def class_conflicts(existing, requested):
    """Include partial overlaps, while allowing classes to meet end-to-start."""
    scheduled = list(existing)
    conflicts = {}
    for item in requested:
        for other in scheduled:
            if (item["day"] == other["day"] and item["start"] < other["end"]
                    and item["end"] > other["start"]):
                conflicts.setdefault(class_key(other), other)
        scheduled.append(item)
    return list(conflicts.values())


def user_classes(db, username):
    return [dict(row) for row in db.execute(
        "SELECT id, subject, day, start, end, room, color FROM classes WHERE username = ?",
        (username,),
    )]


class Handler(SimpleHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(30)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, status, payload, cookie=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            if SECURE_COOKIES:
                cookie += "; Secure"
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid request") from None
        if length < 1 or length > 65536:
            raise ValueError("Invalid request size")
        try:
            value = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            raise ValueError("Invalid JSON") from None
        if not isinstance(value, dict):
            raise ValueError("Invalid request")
        return value

    def current_user(self, db):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        if "bellhop_session" not in cookie:
            return None
        token = cookie["bellhop_session"].value
        digest = hashlib.sha256(token.encode()).hexdigest()
        return db.execute(
            "SELECT users.username, users.display_name FROM sessions "
            "JOIN users ON users.username = sessions.username "
            "WHERE token_hash = ? AND expires_at > ?", (digest, int(time.time()))
        ).fetchone()

    def new_session(self, db, user):
        token = secrets.token_urlsafe(32)
        db.execute("INSERT INTO sessions VALUES (?, ?, ?)",
                   (hashlib.sha256(token.encode()).hexdigest(), user["username"],
                    int(time.time()) + SESSION_SECONDS))
        db.commit()
        cookie = f"bellhop_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_SECONDS}"
        self.send_json(200, {"user": user["username"], "name": user["display_name"]}, cookie)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health":
            self.send_json(200, {"ok": True})
            return
        if path.startswith("/api/"):
            with database() as db:
                user = self.current_user(db)
                if not user:
                    self.send_json(401, {"error": "Please log in."})
                elif path == "/api/session":
                    self.send_json(200, {"user": user["username"], "name": user["display_name"]})
                elif path == "/api/classes":
                    rows = db.execute(
                        "SELECT id, subject, day, start, end, room, color FROM classes WHERE username = ?",
                        (user["username"],)
                    ).fetchall()
                    settings = db.execute(
                        "SELECT schedule_mode, cycle_start FROM users WHERE username = ?",
                        (user["username"],)
                    ).fetchone()
                    self.send_json(200, {
                        "classes": [dict(row) for row in rows],
                        "mode": settings["schedule_mode"],
                        "cycleStart": settings["cycle_start"],
                    })
                else:
                    self.send_json(404, {"error": "Not found."})
            return
        # Serve only the site assets; the database and server code stay private.
        if unquote(path).lstrip("/") not in PUBLIC_FILES and path != "/":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_GET()

    def do_HEAD(self):
        path = urlsplit(self.path).path
        if unquote(path).lstrip("/") not in PUBLIC_FILES and path != "/":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        super().do_HEAD()

    def do_POST(self):
        path = urlsplit(self.path).path
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        if origin and urlsplit(origin).netloc != host and origin not in ALLOWED_ORIGINS:
            self.send_json(403, {"error": "Request blocked."})
            return
        if not path.startswith("/api/"):
            self.send_json(404, {"error": "Not found."})
            return
        try:
            if path == "/api/pdf/preview":
                with database() as db:
                    if not self.current_user(db):
                        self.send_json(401, {"error": "Please log in."})
                        return
                if self.headers.get("Content-Type", "").split(";")[0] != "application/pdf":
                    raise ValueError("Choose a PDF file.")
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    raise ValueError("Invalid PDF size") from None
                if length < 5 or length > 5 * 1024 * 1024:
                    raise ValueError("PDF must be smaller than 5 MB.")
                pdf_bytes = self.rfile.read(length)
                classes = extract_pdf_classes(pdf_bytes)
                if not classes:
                    self.send_json(422, {"error": "No classes found. Try a text-based PDF with Day 1–10 labels and class times, or share the PDF so the importer can be adapted."})
                    return
                found_days = {item["day"] for item in classes}
                self.send_json(200, {
                    "classes": classes[:200],
                    "foundDays": sorted(found_days, key=lambda value: int(value.split()[1])),
                    "truncated": len(classes) > 200,
                    "suggestedDayOne": suggest_day_one(pdf_bytes),
                })
                return
            data = self.read_json()
            self.handle_api(path, data)
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
        except INTEGRITY_ERRORS:
            self.send_json(409, {"error": "That account or class already exists. Try again."})

    def handle_api(self, path, data):
        now = int(time.time())
        with database() as db:
            if path in ("/api/signup", "/api/login", "/api/migrate"):
                name = data.get("name", "")
                password = data.get("password", "")
                if not isinstance(name, str) or not 1 <= len(name.strip()) <= 30 or not isinstance(password, str):
                    raise ValueError("Enter a name and password.")
                name = name.strip()
                username = name.lower()
                user = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
                if path == "/api/signup":
                    if user:
                        self.send_json(409, {"error": "That name is taken. Log in instead."})
                        return
                    if len(password) < 8 or len(password) > 1024 or password.lower() == username:
                        raise ValueError("Use a password of at least 8 characters that isn't your name.")
                    salt = os.urandom(16)
                    iterations = 250000
                    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
                    db.execute("INSERT INTO users (username, display_name, salt, password_hash, iterations) VALUES (?, ?, ?, ?, ?)",
                               (username, name, salt, digest, iterations))
                elif path == "/api/migrate":
                    if user:
                        self.send_json(409, {"error": "This account already exists on the server. Log in instead."})
                        return
                    legacy = data.get("legacy", {})
                    try:
                        salt = base64.b64decode(legacy["salt"], validate=True)
                        digest = base64.b64decode(legacy["hash"], validate=True)
                        iterations = int(legacy["iterations"])
                        if len(salt) != 16 or len(digest) != 32 or not 100000 <= iterations <= 1000000:
                            raise ValueError()
                    except (KeyError, TypeError, ValueError):
                        raise ValueError("Old account data is invalid.") from None
                    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
                    if not hmac.compare_digest(actual, digest):
                        self.send_json(401, {"error": "Wrong password."})
                        return
                    raw_classes = data.get("classes", [])
                    if not isinstance(raw_classes, list) or len(raw_classes) > 200:
                        raise ValueError("Too many classes to transfer.")
                    classes = [validate_class(item) for item in raw_classes]
                    db.execute("INSERT INTO users (username, display_name, salt, password_hash, iterations, legacy_import_done) VALUES (?, ?, ?, ?, ?, 1)",
                               (username, name, salt, digest, iterations))
                    for item in classes:
                        save_class(db, username, item)
                else:
                    if not user:
                        self.send_json(404, {"error": "No account with that name yet. If you made one before, log in once from your original browser to bring it over."})
                        return
                    if user["locked_until"] > now:
                        self.send_json(429, {"error": f"Too many wrong tries. Try again in {user['locked_until'] - now} seconds."})
                        return
                    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), user["salt"], user["iterations"])
                    if not hmac.compare_digest(actual, user["password_hash"]):
                        failures = user["failures"] + 1
                        locked_until = now + 60 if failures >= 5 else 0
                        db.execute("UPDATE users SET failures = ?, locked_until = ? WHERE username = ?",
                                   (0 if locked_until else failures, locked_until, username))
                        db.commit()
                        self.send_json(401, {"error": "Wrong password. Try again in 60 seconds." if locked_until else f"Wrong password. {5 - failures} tries left."})
                        return
                    db.execute("UPDATE users SET failures = 0, locked_until = 0 WHERE username = ?", (username,))
                db.commit()
                user = db.execute("SELECT username, display_name FROM users WHERE username = ?", (username,)).fetchone()
                self.new_session(db, user)
                return

            user = self.current_user(db)
            if not user:
                self.send_json(401, {"error": "Please log in."})
                return
            username = user["username"]
            if path == "/api/logout":
                cookie = SimpleCookie()
                cookie.load(self.headers.get("Cookie", ""))
                if "bellhop_session" in cookie:
                    digest = hashlib.sha256(cookie["bellhop_session"].value.encode()).hexdigest()
                    db.execute("DELETE FROM sessions WHERE token_hash = ?", (digest,))
                    db.commit()
                self.send_json(200, {"ok": True}, "bellhop_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
            elif path == "/api/settings":
                mode = data.get("mode")
                if mode not in ("weekly", "cycle"):
                    raise ValueError("Invalid timetable mode.")
                if mode == "cycle":
                    cycle_start = validate_cycle_start(data.get("cycleStart"))
                    db.execute("UPDATE users SET schedule_mode = ?, cycle_start = ? WHERE username = ?",
                               (mode, cycle_start, username))
                else:
                    db.execute("UPDATE users SET schedule_mode = ? WHERE username = ?", (mode, username))
                db.commit()
                self.send_json(200, {"ok": True})
            elif path == "/api/classes/add":
                raw_classes = data.get("classes", [data.get("class")])
                if not isinstance(raw_classes, list) or not 1 <= len(raw_classes) <= 10:
                    raise ValueError("Add 1–10 classes at a time.")
                items = [validate_class(item) for item in raw_classes]
                if len({item["id"] for item in items}) != len(items):
                    raise ValueError("Each class needs a different ID.")
                db.execute("BEGIN IMMEDIATE")
                mode = db.execute("SELECT schedule_mode FROM users WHERE username = ?", (username,)).fetchone()["schedule_mode"]
                if any(item["day"] not in (CYCLE_DAYS if mode == "cycle" else WEEK_DAYS) for item in items):
                    raise ValueError("Choose a day in the current timetable.")
                existing = user_classes(db, username)
                if {item["id"] for item in items} & {item["id"] for item in existing}:
                    raise ValueError("That class was already saved. Refresh your timetable.")
                conflicts = class_conflicts(existing, items)
                if conflicts:
                    self.send_json(409, {"error": "That time overlaps another class. Choose a different time or day.", "conflicts": conflicts})
                    return
                for item in items:
                    save_class(db, username, item)
                db.execute("UPDATE users SET legacy_import_done = 1 WHERE username = ?", (username,))
                db.commit()
                self.send_json(200, {"class": items[0], "classes": items})
            elif path == "/api/classes/delete":
                item_id = data.get("id")
                if not isinstance(item_id, str):
                    raise ValueError("Invalid class")
                db.execute("DELETE FROM classes WHERE username = ? AND id = ?", (username, item_id))
                db.execute("UPDATE users SET legacy_import_done = 1 WHERE username = ?", (username,))
                db.commit()
                self.send_json(200, {"ok": True})
            elif path == "/api/classes/clear":
                mode = db.execute("SELECT schedule_mode FROM users WHERE username = ?", (username,)).fetchone()["schedule_mode"]
                days = CYCLE_DAYS if mode == "cycle" else WEEK_DAYS
                db.executemany("DELETE FROM classes WHERE username = ? AND day = ?",
                               ((username, day) for day in days))
                db.execute("UPDATE users SET legacy_import_done = 1 WHERE username = ?", (username,))
                db.commit()
                self.send_json(200, {"ok": True})
            elif path == "/api/classes/import-if-empty":
                raw_classes = data.get("classes", [])
                if not isinstance(raw_classes, list) or len(raw_classes) > 200:
                    raise ValueError("Too many classes to transfer.")
                classes = [validate_class(item) for item in raw_classes]
                db.execute("BEGIN IMMEDIATE")
                already_done = db.execute("SELECT legacy_import_done FROM users WHERE username = ?", (username,)).fetchone()["legacy_import_done"]
                count = db.execute("SELECT COUNT(*) AS count FROM classes WHERE username = ?", (username,)).fetchone()["count"]
                if count or already_done:
                    self.send_json(200, {"imported": False})
                    return
                for item in classes:
                    save_class(db, username, item)
                db.execute("UPDATE users SET legacy_import_done = 1 WHERE username = ?", (username,))
                db.commit()
                self.send_json(200, {"imported": True})
            elif path == "/api/classes/import-cycle":
                raw_classes = data.get("classes")
                if not isinstance(raw_classes, list) or not 1 <= len(raw_classes) <= 200:
                    raise ValueError("Add 1–200 classes to import.")
                cycle_start = validate_cycle_start(data.get("cycleStart"))
                classes = [validate_class(item) for item in raw_classes]
                if any(item["day"] not in CYCLE_DAYS for item in classes):
                    raise ValueError("Imported classes must use Day 1–10.")
                db.execute("BEGIN IMMEDIATE")
                existing = user_classes(db, username)
                keys = {class_key(item) for item in existing}
                new_classes = []
                for item in classes:
                    key = class_key(item)
                    if key in keys:
                        continue
                    keys.add(key)
                    new_classes.append(item)
                if len({item["id"] for item in new_classes}) != len(new_classes) or ({item["id"] for item in new_classes} & {item["id"] for item in existing}):
                    raise ValueError("Class IDs are repeated. Preview the PDF again.")
                conflicts = class_conflicts(existing, new_classes)
                if conflicts:
                    self.send_json(409, {"error": "Some imported classes overlap. Review their days and times before importing.", "conflicts": conflicts})
                    return
                for item in new_classes:
                    save_class(db, username, item)
                db.execute("UPDATE users SET schedule_mode = 'cycle', cycle_start = ?, legacy_import_done = 1 WHERE username = ?",
                           (cycle_start, username))
                db.commit()
                self.send_json(200, {"imported": len(new_classes), "skipped": len(classes) - len(new_classes)})
            else:
                self.send_json(404, {"error": "Not found."})


if __name__ == "__main__":
    initialize_database()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Bellhop listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
