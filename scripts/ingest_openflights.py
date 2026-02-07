#!/usr/bin/env python3
import argparse
import csv
import math
import sqlite3
from pathlib import Path
from typing import Dict, Tuple, List


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(
        math.radians(lat2)
    ) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def load_airports(path: Path) -> Dict[int, Tuple[str, float, float, str]]:
    airports: Dict[int, Tuple[str, float, float, str]] = {}
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        for row in reader:
            if len(row) < 8:
                continue
            try:
                airport_id = int(row[0])
                code = row[4].strip().upper()
                country = row[3].strip() if len(row) > 3 else ""
                lat = float(row[6])
                lon = float(row[7])
            except (ValueError, IndexError):
                continue
            airports[airport_id] = (code, lat, lon, country)
    return airports


def load_routes(path: Path, airports: Dict[int, Tuple[str, float, float, str]]) -> List[Tuple[int, int, float]]:
    routes: List[Tuple[int, int, float]] = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        for row in reader:
            if len(row) < 6:
                continue
            try:
                src_id = int(row[3])
                dst_id = int(row[5])
            except (ValueError, IndexError):
                continue
            src = airports.get(src_id)
            dst = airports.get(dst_id)
            if not src or not dst:
                continue
            distance = haversine(src[1], src[2], dst[1], dst[2])
            routes.append((src_id, dst_id, distance))
    return routes


def ensure_schema(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute("DROP TABLE IF EXISTS routes;")
    cur.execute("DROP TABLE IF EXISTS airports;")
    cur.execute(
        """
        CREATE TABLE airports (
            id INTEGER PRIMARY KEY,
            code TEXT NOT NULL,
            name TEXT DEFAULT '',
            country TEXT DEFAULT '',
            latitude REAL NOT NULL,
            longitude REAL NOT NULL
        );
        """
    )
    cur.execute(
        """
        CREATE TABLE routes (
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


def seed_data(conn: sqlite3.Connection,
              airports: Dict[int, Tuple[str, float, float, str]],
              routes: List[Tuple[int, int, float]]) -> None:
    cur = conn.cursor()
    cur.executemany(
        "INSERT INTO airports (id, code, country, latitude, longitude) VALUES (?, ?, ?, ?, ?);",
        [(aid, info[0], info[3], info[1], info[2]) for aid, info in sorted(airports.items(), key=lambda kv: kv[0])],
    )
    cur.executemany(
        "INSERT INTO routes (src_id, dst_id, distance_km) VALUES (?, ?, ?);",
        routes,
    )
    conn.commit()


def main():
    parser = argparse.ArgumentParser(description="Convert OpenFlights CSV dumps into NukeDB format.")
    parser.add_argument("--airports", required=True, type=Path, help="Path to airports.dat")
    parser.add_argument("--routes", required=True, type=Path, help="Path to routes.dat")
    parser.add_argument("--output", default=Path("data/nuke_routes.db"), type=Path, help="SQLite destination file")
    args = parser.parse_args()

    airports = load_airports(args.airports)
    if not airports:
        raise SystemExit("No airports parsed from dataset.")
    routes = load_routes(args.routes, airports)
    if not routes:
        raise SystemExit("No routes parsed from dataset.")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(args.output)
    try:
        ensure_schema(conn)
        seed_data(conn, airports, routes)
    finally:
        conn.close()
    print(f"Wrote {len(airports)} airports and {len(routes)} routes to {args.output}")


if __name__ == "__main__":
    main()
