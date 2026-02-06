#!/usr/bin/env python3
"""
Utility script to fetch the latest OpenFlights CSV dumps into data/raw.

The script intentionally sticks to the Python standard library so it can
run in firewalled environments without pip-installing anything.
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterable, Tuple


DEFAULT_BASE_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data"
DATASETS: Tuple[Tuple[str, str], ...] = (
    ("airports.dat", f"{DEFAULT_BASE_URL}/airports.dat"),
    ("routes.dat", f"{DEFAULT_BASE_URL}/routes.dat"),
)


def human_bytes(size: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    value = float(size)
    for unit in units:
        if value < 1024.0 or unit == units[-1]:
            return f"{value:.1f} {unit}"
        value /= 1024.0
    return f"{value:.1f} TB"


def download(url: str, destination: Path, timeout: int, chunk_size: int = 64 * 1024) -> int:
    request = urllib.request.Request(url, headers={"User-Agent": "NukeDB-OpenFlightsDownloader/1.0"})
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(prefix=destination.stem, suffix=".part", dir=destination.parent)
    bytes_written = 0
    try:
        with os.fdopen(tmp_fd, "wb") as tmp_file, urllib.request.urlopen(request, timeout=timeout) as response:
            while True:
                chunk = response.read(chunk_size)
                if not chunk:
                    break
                tmp_file.write(chunk)
                bytes_written += len(chunk)
        Path(tmp_path).replace(destination)
    except Exception:
        try:
            os.remove(tmp_path)
        except FileNotFoundError:
            pass
        raise
    return bytes_written


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download OpenFlights CSV dumps into data/raw.")
    parser.add_argument(
        "--dest",
        type=Path,
        default=Path("data/raw"),
        help="Directory where airports.dat and routes.dat will be stored (default: data/raw)",
    )
    parser.add_argument("--airports-url", default=DATASETS[0][1], help="Override source URL for airports.dat")
    parser.add_argument("--routes-url", default=DATASETS[1][1], help="Override source URL for routes.dat")
    parser.add_argument("--timeout", type=int, default=60, help="Network timeout per request in seconds (default: 60)")
    parser.add_argument("--force", action="store_true", help="Force re-download even if files already exist")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress messages")
    return parser.parse_args(list(argv))


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    tasks = (
        ("airports.dat", args.airports_url, args.dest / "airports.dat"),
        ("routes.dat", args.routes_url, args.dest / "routes.dat"),
    )
    failures = []
    for label, url, path in tasks:
        if not args.force and path.exists():
            if not args.quiet:
                print(f"[skip] {label} already exists at {path}")
            continue
        if not args.quiet:
            print(f"[fetch] {label} <- {url}")
        try:
            written = download(url, path, timeout=args.timeout)
        except urllib.error.URLError as exc:
            failures.append((label, f"network error: {exc.reason!s}"))
        except Exception as exc:  # pragma: no cover - defensive logging
            failures.append((label, f"unexpected error: {exc!s}"))
        else:
            if not args.quiet:
                print(f"[done]  {label}: {human_bytes(written)} written to {path}")
    if failures:
        for label, reason in failures:
            print(f"[fail] {label}: {reason}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
