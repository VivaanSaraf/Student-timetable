"""Move local Bellhop users/classes to Postgres; receive the URL privately on stdin."""

import os
import sqlite3
import sys
from pathlib import Path


def migrate():
    connection_url = sys.stdin.readline().strip()
    if not connection_url.startswith(("postgres://", "postgresql://")):
        raise ValueError("A Postgres connection is required.")
    os.environ["DATABASE_URL"] = connection_url
    from storage import DB_PATH, database, initialize_database

    initialize_database()
    source = sqlite3.connect(Path(DB_PATH).resolve().as_uri() + "?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    accounts = 0
    classes = 0
    try:
        with database() as destination:
            destination.execute("BEGIN IMMEDIATE")
            for user in source.execute("SELECT * FROM users"):
                existing = destination.execute("SELECT password_hash FROM users WHERE username = ?", (user["username"],)).fetchone()
                if existing and bytes(existing["password_hash"]) != bytes(user["password_hash"]):
                    raise ValueError("An online account has a different password check. Migration stopped without replacing it.")
                if not existing:
                    destination.execute(
                        "INSERT INTO users (username, display_name, salt, password_hash, iterations, "
                        "legacy_import_done, schedule_mode, cycle_start) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
                        tuple(user[key] for key in ("username", "display_name", "salt", "password_hash", "iterations", "schedule_mode", "cycle_start")),
                    )
                    accounts += 1
                for item in source.execute("SELECT * FROM classes WHERE username = ?", (user["username"],)):
                    cursor = destination.execute(
                        "INSERT INTO classes (username, id, subject, day, start, end, room, color) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (username, id) DO NOTHING",
                        tuple(item[key] for key in ("username", "id", "subject", "day", "start", "end", "room", "color")),
                    )
                    classes += cursor.rowcount
        print(f"Moved {accounts} accounts and {classes} classes. Local data retained; sessions were not copied.")
    finally:
        source.close()


if __name__ == "__main__":
    try:
        migrate()
    except Exception as error:
        print(f"Migration stopped ({type(error).__name__}). No database credentials were logged.", file=sys.stderr)
        sys.exit(1)
