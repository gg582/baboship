#!/usr/bin/env python3
"""
Ingest the GeoNames cities500 dump into a compact docs/cities.json gazetteer.

The script intentionally sticks to the Python standard library so it can
run in firewalled environments without pip-installing anything. The source
dump (cities500.zip) is downloaded into data/raw/ and reused on later runs
unless --force is passed.

Output rows: [name, ascii_name, country_code, lat, lon, population]
sorted by population descending. GeoNames data is licensed CC-BY 4.0.
"""
from __future__ import annotations

import argparse
import io
import json
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from datetime import date
from pathlib import Path
from typing import Iterable, List

DEFAULT_URL = "https://download.geonames.org/export/dump/cities500.zip"

# Column indices in the GeoNames dump format (see geonames.org/export/readme.txt)
COL_GEONAMEID = 0
COL_NAME = 1
COL_ASCIINAME = 2
COL_LATITUDE = 4
COL_LONGITUDE = 5
COL_COUNTRY_CODE = 8
COL_POPULATION = 14


def human_bytes(size: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    value = float(size)
    for unit in units:
        if value < 1024.0 or unit == units[-1]:
            return f"{value:.1f} {unit}"
        value /= 1024.0
    return f"{value:.1f} TB"


def download(url: str, destination: Path, timeout: int) -> int:
    """Download via urllib first; fall back to curl -fL if urllib fails."""
    request = urllib.request.Request(url, headers={"User-Agent": "BaboShip-CitiesDownloader/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = response.read()
    except Exception as exc:
        print(f"[fetch] urllib failed ({exc!s}); retrying with curl -fL", file=sys.stderr)
        subprocess.run(
            ["curl", "-fL", "--retry", "3", "-o", str(destination), url],
            check=True,
        )
        return destination.stat().st_size
    destination.write_bytes(data)
    return len(data)


def parse_cities(zip_path: Path, min_population: int) -> List[list]:
    cities: List[list] = []
    with zipfile.ZipFile(zip_path) as archive:
        names = [n for n in archive.namelist() if n.endswith(".txt")]
        if not names:
            raise SystemExit(f"No .txt dump found inside {zip_path}")
        with archive.open(names[0]) as handle:
            for raw_line in io.TextIOWrapper(handle, encoding="utf-8"):
                fields = raw_line.rstrip("\n").split("\t")
                if len(fields) <= COL_POPULATION:
                    continue
                try:
                    lat = float(fields[COL_LATITUDE])
                    lon = float(fields[COL_LONGITUDE])
                    population = int(fields[COL_POPULATION] or 0)
                except ValueError:
                    continue
                if population < min_population:
                    continue
                name = fields[COL_NAME].strip()
                ascii_name = fields[COL_ASCIINAME].strip() or name
                country = fields[COL_COUNTRY_CODE].strip()
                cities.append([name, ascii_name, country, round(lat, 4), round(lon, 4), population])
    cities.sort(key=lambda row: row[5], reverse=True)
    return cities


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest GeoNames cities500 into docs/cities.json.")
    parser.add_argument("--url", default=DEFAULT_URL, help="Source URL of the cities500.zip dump")
    parser.add_argument("--source", type=Path, default=Path("data/raw/cities500.zip"), help="Local path of the downloaded dump")
    parser.add_argument("--output", type=Path, default=Path("docs/cities.json"), help="Destination JSON file")
    parser.add_argument("--min-population", type=int, default=10000, help="Minimum population to keep (default: 10000)")
    parser.add_argument("--timeout", type=int, default=120, help="Network timeout in seconds (default: 120)")
    parser.add_argument("--force", action="store_true", help="Force re-download even if the dump already exists")
    return parser.parse_args(list(argv))


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)

    if not args.force and args.source.exists():
        print(f"[skip] {args.source.name} already exists at {args.source}")
    else:
        args.source.parent.mkdir(parents=True, exist_ok=True)
        print(f"[fetch] {args.source.name} <- {args.url}")
        written = download(args.url, args.source, timeout=args.timeout)
        print(f"[done]  {args.source.name}: {human_bytes(written)} written to {args.source}")

    cities = parse_cities(args.source, args.min_population)
    if not cities:
        raise SystemExit("No cities parsed from the dump.")

    payload = {
        "source": "GeoNames cities500 (CC-BY 4.0)",
        "updated": date.today().isoformat(),
        "cities": cities,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=args.output.parent, delete=False) as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        tmp_path = Path(handle.name)
    tmp_path.replace(args.output)

    size = args.output.stat().st_size
    print(f"Exported {len(cities)} cities (pop >= {args.min_population}) to {args.output} ({human_bytes(size)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
