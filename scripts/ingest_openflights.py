#!/usr/bin/env python3
import argparse
import csv
import math
import sqlite3
from pathlib import Path
from typing import Dict, Tuple, List, Any


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(
        math.radians(lat2)
    ) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def load_airports(path: Path) -> Tuple[List[Tuple[str, str, str, float, float, str]], Dict[int, str]]:
    """
    Loads airport data from a CSV, returning a list of node tuples and a mapping
    from original airport_id to airport code. Deduplicates nodes by code.
    """
    nodes_data: List[Tuple[str, str, str, float, float, str]] = []
    airport_id_to_code: Dict[int, str] = {}
    seen_codes: Dict[str, bool] = {} # To track unique codes

    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        for row in reader:
            if len(row) < 8:
                continue
            try:
                airport_id = int(row[0])
                name = row[1].strip()
                code = row[4].strip().upper()
                country = row[3].strip()
                lat = float(row[6])
                lon = float(row[7])
            except (ValueError, IndexError):
                continue
            
            # Deduplicate by code
            if code and code not in seen_codes:
                nodes_data.append((code, name, country, lat, lon, 'air'))
                airport_id_to_code[airport_id] = code
                seen_codes[code] = True
            elif code and code in seen_codes:
                # If code is a duplicate, we still need to map the original airport_id to this code
                # but we don't add the node again to nodes_data.
                # This ensures routes referencing this airport_id can still resolve to the code.
                if airport_id not in airport_id_to_code: # Only add if this specific airport_id hasn't been mapped yet
                    airport_id_to_code[airport_id] = code
    return nodes_data, airport_id_to_code


def load_routes(path: Path, airport_id_to_code: Dict[int, str], nodes_map: Dict[str, Tuple[str, float, float, str]]) -> List[Tuple[str, str, float, str]]:
    """
    Loads route data from a CSV, returning a list of route tuples referring to node codes.
    """
    routes_data: List[Tuple[str, str, float, str]] = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        for row in reader:
            if len(row) < 6:
                continue
            try:
                src_airport_id = int(row[3])
                dst_airport_id = int(row[5])
            except (ValueError, IndexError):
                continue

            src_code = airport_id_to_code.get(src_airport_id)
            dst_code = airport_id_to_code.get(dst_airport_id)
            
            if not src_code or not dst_code:
                continue

            src_node_info = nodes_map.get(src_code)
            dst_node_info = nodes_map.get(dst_code)

            if not src_node_info or not dst_node_info:
                continue
            
            # nodes_map stores (name, country, lat, lon, layer)
            distance = haversine(src_node_info[2], src_node_info[3], dst_node_info[2], dst_node_info[3])
            routes_data.append((src_code, dst_code, distance, 'air'))
    return routes_data


def seed_data(conn: sqlite3.Connection,
              nodes_data: List[Tuple[str, str, str, float, float, str]], # code, name, country, lat, lon, layer
              routes_data: List[Tuple[str, str, float, str]]) -> None: # src_code, dst_code, distance_km, layer
    cur = conn.cursor()

    # Create a mapping for existing nodes in the DB to avoid duplicates and get their IDs
    existing_nodes: Dict[str, int] = {} # code -> id
    cur.execute("SELECT code, id FROM nodes;")
    for code, node_id in cur.fetchall():
        existing_nodes[code] = node_id

    # List to hold nodes to be inserted
    nodes_to_insert: List[Tuple[str, str, str, float, float, str]] = []
    
    # Map to hold all node codes to their actual DB IDs (newly inserted or existing)
    all_node_code_to_id: Dict[str, int] = existing_nodes.copy()

    # Identify new nodes and prepare for insertion
    for node in nodes_data:
        code = node[0]
        if code not in existing_nodes:
            nodes_to_insert.append(node)
            
    # Insert new nodes
    if nodes_to_insert:
        cur.executemany(
            "INSERT INTO nodes (code, name, country, latitude, longitude, layer) VALUES (?, ?, ?, ?, ?, ?);",
            nodes_to_insert
        )
        # Fetch the IDs of newly inserted nodes. This assumes SQLite's ROWID is consecutive,
        # or we re-query for the codes. Re-querying is safer.
        cur.execute("SELECT code, id FROM nodes WHERE code IN (%s);" % ",".join("?" * len(nodes_to_insert)),
                    [node[0] for node in nodes_to_insert])
        for code, node_id in cur.fetchall():
            all_node_code_to_id[code] = node_id

    # Prepare routes for insertion
    routes_to_insert_db: List[Tuple[int, int, float, str]] = [] # (src_id, dst_id, distance_km, layer)
    for src_code, dst_code, distance_km, layer in routes_data:
        src_id = all_node_code_to_id.get(src_code)
        dst_id = all_node_code_to_id.get(dst_code)
        if src_id is None or dst_id is None:
            print(f"Warning: Missing node ID for route from {src_code} to {dst_code}. Skipping route.")
            continue
        routes_to_insert_db.append((src_id, dst_id, distance_km, layer))

    # Insert new routes (assuming routes are always new for each ingestion run, or handling duplicates if needed)
    # For now, simply insert. A more robust solution might check for existing routes.
    if routes_to_insert_db:
        cur.executemany(
            "INSERT INTO routes (src_id, dst_id, distance_km, layer) VALUES (?, ?, ?, ?);",
            routes_to_insert_db
        )
    conn.commit()


def main():
    parser = argparse.ArgumentParser(description="Ingest OpenFlights CSV dumps into NukeDB format.")
    parser.add_argument("--airports", required=True, type=Path, help="Path to airports.dat")
    parser.add_argument("--routes", required=True, type=Path, help="Path to routes.dat")
    parser.add_argument("--output", default=Path("data/nuke_routes.db"), type=Path, help="SQLite destination file")
    args = parser.parse_args()

    # Temporary map to get (lat, lon) for haversine calculation within load_routes
    # This map needs to be built from the nodes_data returned by load_airports
    temp_nodes_map: Dict[str, Tuple[str, str, float, float, str]] = {} # code -> (name, country, lat, lon, layer)

    # Load airports (nodes) data
    nodes_data, airport_id_to_code = load_airports(args.airports)
    for code, name, country, lat, lon, layer in nodes_data:
        temp_nodes_map[code] = (name, country, lat, lon, layer)

    # Load routes data
    routes_data = load_routes(args.routes, airport_id_to_code, temp_nodes_map)
    
    if not nodes_data:
        raise SystemExit("No airports parsed from dataset.")
    if not routes_data:
        raise SystemExit("No routes parsed from dataset.")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(args.output)
    try:
        seed_data(conn, nodes_data, routes_data)
    finally:
        conn.close()
    print(f"Wrote {len(nodes_data)} air nodes and {len(routes_data)} air routes to {args.output}")


if __name__ == "__main__":
    main()
