"""Local SQLite storage and persistent Postgres storage for hosted Bellhop."""

import os
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    psycopg = None

DATABASE_URL = os.environ.get("DATABASE_URL", "")
DB_PATH = Path(os.environ.get("BELLHOP_DB", Path(__file__).parent / "data" / "bellhop.sqlite3"))
INTEGRITY_ERRORS = (sqlite3.IntegrityError,) + ((psycopg.IntegrityError,) if psycopg else ())

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    salt BYTEA NOT NULL,
    password_hash BYTEA NOT NULL,
    iterations INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    locked_until BIGINT NOT NULL DEFAULT 0,
    legacy_import_done INTEGER NOT NULL DEFAULT 0,
    schedule_mode TEXT NOT NULL DEFAULT 'weekly',
    cycle_start TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES users(username),
    expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS classes (
    username TEXT NOT NULL REFERENCES users(username),
    id TEXT NOT NULL,
    subject TEXT NOT NULL,
    day TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    room TEXT NOT NULL,
    color TEXT NOT NULL,
    PRIMARY KEY (username, id)
);
"""


class PostgresDatabase:
    def __init__(self, connection):
        self.connection = connection

    def execute(self, query, params=()):
        if query == "BEGIN IMMEDIATE":
            # Serialize schedule changes, including multi-day conflict checks.
            return self.connection.execute("SELECT pg_advisory_xact_lock(731984023)")
        query = re.sub(r"\bend\b", '"end"', query, flags=re.I)
        return self.connection.execute(query.replace("?", "%s"), params)

    def executemany(self, query, params):
        with self.connection.cursor() as cursor:
            query = re.sub(r"\bend\b", '"end"', query, flags=re.I)
            cursor.executemany(query.replace("?", "%s"), params)

    def commit(self):
        self.connection.commit()


@contextmanager
def database():
    if DATABASE_URL:
        if not psycopg:
            raise RuntimeError("Install requirements.txt to use the online database.")
        with psycopg.connect(DATABASE_URL, row_factory=dict_row, connect_timeout=15) as connection:
            yield PostgresDatabase(connection)
    else:
        if os.environ.get("RENDER") == "true":
            raise RuntimeError("DATABASE_URL is required on Render to keep saved timetables.")
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(DB_PATH, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=10000")
        try:
            with connection:
                yield connection
        finally:
            connection.close()


def initialize_database():
    with database() as db:
        for statement in SCHEMA.split(";"):
            if statement.strip():
                db.execute(statement)
        if not DATABASE_URL:
            columns = {row[1] for row in db.execute("PRAGMA table_info(users)")}
            for name, kind in (("legacy_import_done", "INTEGER NOT NULL DEFAULT 0"),
                               ("schedule_mode", "TEXT NOT NULL DEFAULT 'weekly'"),
                               ("cycle_start", "TEXT")):
                if name not in columns:
                    db.execute(f"ALTER TABLE users ADD COLUMN {name} {kind}")
