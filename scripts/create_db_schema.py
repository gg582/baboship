#!/usr/bin/env python3
import argparse
import sqlite3
from pathlib import Path


def ensure_schema(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    
    # Drop tables in reverse order of foreign key dependency
    cur.execute("DROP TABLE IF EXISTS routes;")
    cur.execute("DROP TABLE IF EXISTS nodes;")
    
    cur.execute(
        """
        CREATE TABLE nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            name TEXT DEFAULT '',
            country TEXT DEFAULT '',
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            layer TEXT NOT NULL
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
            layer TEXT NOT NULL,
            path_geojson TEXT,
            FOREIGN KEY (src_id) REFERENCES nodes(id),
            FOREIGN KEY (dst_id) REFERENCES nodes(id)
        );
        """
    )
    conn.commit()


def main():
    parser = argparse.ArgumentParser(description="Ensures the NukeDB schema exists.")
    parser.add_argument("--output", default=Path("data/nuke_routes.db"), type=Path, help="SQLite destination file")
    args = parser.parse_args()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(args.output)
    try:
        ensure_schema(conn)
        print(f"Schema created for {args.output}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
