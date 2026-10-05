#!/usr/bin/env python3
"""
Ingest GeoNames postal-code dumps into data/nuke_routes.db as layer='post'
(postal office) nodes for precise origin/destination distance calculation.

Sticks to the Python standard library only (urllib/zipfile), matching the
other ingestion scripts. Dumps are downloaded into data/raw/postal/ and
reused on later runs unless --force is passed.

Row policy: countries with few unique codes (<= --full-code-cap) keep one
node per exact postal code; larger countries are aggregated to one centroid
node per 3-digit code prefix. The total row count is capped (default 50k);
excess rows are dropped with a warning. GeoNames postal data is licensed
CC-BY 4.0 (https://download.geonames.org/export/zip/).
"""
from __future__ import annotations

import argparse
import io
import math
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

DEFAULT_COUNTRIES = ["KR", "CN", "JP", "SG", "US", "DE", "NL", "GB", "HK", "AE"]
DEFAULT_BASE_URL = "https://download.geonames.org/export/zip/{}.zip"

# Column indices in the GeoNames postal dump format
COL_COUNTRY = 0
COL_POSTAL_CODE = 1
COL_PLACE_NAME = 2
COL_LAT = 9
COL_LON = 10


def download(url: str, destination: Path, timeout: int) -> int:
    """Download via urllib first; fall back to curl -fL if urllib fails."""
    request = urllib.request.Request(url, headers={"User-Agent": "BaboShip-PostalDownloader/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = response.read()
    except Exception as exc:
        print(f"[fetch] urllib failed ({exc!s}); retrying with curl -fL", file=sys.stderr)
        subprocess.run(
            ["curl", "-fsSL", "--retry", "3", "-o", str(destination), url],
            check=True,
        )
        return destination.stat().st_size
    destination.write_bytes(data)
    return len(data)


def parse_country(zip_path: Path) -> List[Tuple[str, str, float, float, int]]:
    """Return (code, place_name, lat, lon, occurrence_count) rows."""
    rows: List[Tuple[str, str, float, float, int]] = []
    with zipfile.ZipFile(zip_path) as archive:
        names = [n for n in archive.namelist()
                 if n.endswith(".txt") and not n.lower().startswith("readme")]
        if not names:
            return rows  # e.g. countries GeoNames has no data for (readme only)
        # Prefer the largest .txt member (the actual country dump)
        names.sort(key=lambda n: archive.getinfo(n).file_size, reverse=True)
        with archive.open(names[0]) as handle:
            for raw_line in io.TextIOWrapper(handle, encoding="utf-8"):
                fields = raw_line.rstrip("\n").split("\t")
                if len(fields) <= COL_LON:
                    continue
                code = fields[COL_POSTAL_CODE].strip()
                place = fields[COL_PLACE_NAME].strip()
                try:
                    lat = float(fields[COL_LAT])
                    lon = float(fields[COL_LON])
                except ValueError:
                    continue
                if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                    continue
                if not code:
                    continue
                rows.append((code, place, lat, lon, 1))
    return rows


def bucket_rows(
    rows: List[Tuple[str, str, float, float, int]],
    full_code_cap: int,
) -> List[Tuple[str, str, float, float]]:
    """Keep full codes for small countries, 3-digit-prefix centroids otherwise."""
    unique_codes = {r[0] for r in rows}
    use_full = len(unique_codes) <= full_code_cap

    groups: Dict[str, List[Tuple[str, str, float, float, int]]] = {}
    for code, place, lat, lon, count in rows:
        key = code if use_full else code[:3]
        groups.setdefault(key, []).append((code, place, lat, lon, count))

    out: List[Tuple[str, str, float, float]] = []
    for key, members in groups.items():
        # Weight duplicate entries by occurrence; keep the most frequent name.
        total = sum(m[4] for m in members)
        lat = sum(m[2] * m[4] for m in members) / total
        lon = sum(m[3] * m[4] for m in members) / total
        names: Dict[str, int] = {}
        for m in members:
            names[m[1]] = names.get(m[1], 0) + m[4]
        place = max(names.items(), key=lambda kv: kv[1])[0] if names else ""
        out.append((key, place, round(lat, 5), round(lon, 5)))
    return out


def ingest(db_path: Path, raw_dir: Path, countries: List[str], args: argparse.Namespace) -> int:
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        # Replace any previous postal layer
        cur.execute("DELETE FROM nodes WHERE layer = 'post'")
        cur.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM nodes")
        next_id = cur.fetchone()[0]

        total = 0
        inserted = 0
        for country in countries:
            country = country.upper()
            zip_path = raw_dir / f"{country}.zip"
            if not args.force and zip_path.exists():
                print(f"[skip] {zip_path.name} already exists")
            else:
                zip_path.parent.mkdir(parents=True, exist_ok=True)
                url = args.url_template.format(country)
                print(f"[fetch] {zip_path.name} <- {url}")
                download(url, zip_path, timeout=args.timeout)

            rows = parse_country(zip_path)
            if not rows:
                print(f"[warn] {country}: no postal rows (GeoNames may not cover it); skipping")
                continue
            nodes = bucket_rows(rows, args.full_code_cap)
            total += len(nodes)
            for code, place, lat, lon in nodes:
                if inserted >= args.max_rows:
                    break
                node_code = f"{country}:{code}"
                cur.execute(
                    "INSERT OR REPLACE INTO nodes (code, name, country, latitude, longitude, layer)"
                    " VALUES (?, ?, ?, ?, ?, 'post')",
                    (node_code, place[:120], country, lat, lon),
                )
                inserted += 1
            mode = "full-code" if len({r[0] for r in rows}) <= args.full_code_cap else "3-digit-prefix"
            print(f"[done] {country}: {len(rows)} dump rows -> {len(nodes)} post nodes ({mode})")

        if total > args.max_rows:
            print(
                f"[warn] capped post nodes at {args.max_rows} of {total} (raise --max-rows to keep more)",
                file=sys.stderr,
            )
        conn.commit()
        cur.execute("SELECT COUNT(*) FROM nodes WHERE layer = 'post'")
        print(f"Total layer='post' nodes in {db_path}: {cur.fetchone()[0]}")
    finally:
        conn.close()
    return inserted


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest GeoNames postal dumps as layer='post' nodes.")
    parser.add_argument("--db", type=Path, default=Path("data/nuke_routes.db"))
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw/postal"))
    parser.add_argument("--countries", nargs="*", default=DEFAULT_COUNTRIES)
    parser.add_argument("--url-template", default=DEFAULT_BASE_URL)
    parser.add_argument("--full-code-cap", type=int, default=6000,
                        help="Countries with at most this many unique codes keep full codes (default 6000)")
    parser.add_argument("--max-rows", type=int, default=50000, help="Total post-node cap (default 50000)")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--force", action="store_true", help="Re-download dumps even if present")
    return parser.parse_args(list(argv))


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    ingest(args.db, args.raw_dir, args.countries, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
