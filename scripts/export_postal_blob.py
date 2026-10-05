#!/usr/bin/env python3
"""
Export layer='post' postal nodes from data/nuke_routes.db into the compact
'POST' binary blob consumed by flight_kernel.c (fk_load_postal_blob).

Layout (little-endian):
  magic "POST" (4 bytes) | version u32 (=1) | record count u32
  count * 35-byte records: country char[3] | code char[16] | lat f64 | lon f64

The country prefix ("KR:031" -> country "KR", code "031") is split back out
at export time so the WASM resolver can match codes and country tokens.

Usage: python3 export_postal_blob.py <db_path> <out_path>
"""
import sqlite3
import struct
import sys
from pathlib import Path

MAGIC = b"POST"
VERSION = 1
REC_SIZE = 35  # 3 + 16 + 8 + 8


def export_postal(db_path: str, out_path: str) -> None:
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT code, latitude, longitude FROM nodes WHERE layer = 'post' ORDER BY code ASC"
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    records = []
    for code, lat, lon in rows:
        if ":" in code:
            country, _, bare = code.partition(":")
        else:
            country, bare = "", code
        country = country[:2].upper()
        bare = bare[:15]
        rec = country.encode("ascii").ljust(3, b"\0")
        rec += bare.encode("ascii", "ignore").ljust(16, b"\0")
        rec += struct.pack("<dd", float(lat), float(lon))
        assert len(rec) == REC_SIZE
        records.append(rec)

    with open(out_path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<II", VERSION, len(records)))
        for rec in records:
            f.write(rec)
    print(f"Exported {len(records)} postal records to {out_path}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 export_postal_blob.py <db_path> <out_path>")
        sys.exit(1)
    export_postal(sys.argv[1], sys.argv[2])
