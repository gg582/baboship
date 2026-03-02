#!/usr/bin/env python3
import sqlite3
from pathlib import Path

###################################################
##             !!!!!! WARNING !!!!!!             ##
###################################################
## This is a sample script of a parcel database. ##
## Don't use this on production.                 ##
## Please use automated deploy script with       ##
## uploaded GitHub Actions.                      ##
## (C) Lee Yunjin, 2026.                         ##
###################################################

AIRPORTS = [
    (1, "JFK", "New York JFK", "United States", 40.6413, -73.7781),
    (2, "LHR", "London Heathrow", "United Kingdom", 51.4700, -0.4543),
    (3, "FRA", "Frankfurt", "Germany", 50.0379, 8.5622),
    (4, "ICN", "Seoul Incheon", "South Korea", 37.4602, 126.4407),
    (5, "SIN", "Singapore Changi", "Singapore", 1.3644, 103.9915),
]

ROUTES = [
    (1, 2, 5540.0),
    (1, 3, 3850.0),
    (3, 2, 406.0),
    (2, 4, 5523.0),
    (4, 5, 4625.0),
    (3, 4, 5369.0),
    (1, 4, 6854.0),
    (5, 2, 10850.0),
]


def ensure_schema(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("DROP TABLE IF EXISTS routes;")
    cur.execute("DROP TABLE IF EXISTS airports;")
    cur.execute(
        """
        CREATE TABLE airports (
            id INTEGER PRIMARY KEY,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            country TEXT DEFAULT '',
            latitude REAL NOT NULL,
            longitude REAL NOT NULL
        );
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS routes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            src_id INTEGER NOT NULL,
            dst_id INTEGER NOT NULL,
            distance_km REAL NOT NULL,
            FOREIGN KEY (src_id) REFERENCES airports(id),
            FOREIGN KEY (dst_id) REFERENCES airports(id)
        );
        """
    )
    conn.commit()


def fill_sample(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("DELETE FROM routes;")
    cur.execute("DELETE FROM airports;")
    cur.executemany(
        "INSERT INTO airports (id, code, name, country, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?);",
        AIRPORTS,
    )
    cur.executemany(
        "INSERT INTO routes (src_id, dst_id, distance_km) VALUES (?, ?, ?);",
        ROUTES,
    )
    conn.commit()


def main():
    target = Path("data/nuke_routes.db")
    if not target.parent.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target)
    try:
        ensure_schema(conn)
        fill_sample(conn)
        print(f"Sample dataset written to {target}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
