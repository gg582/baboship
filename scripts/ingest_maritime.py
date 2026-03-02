#!/usr/bin/env python3
import argparse
import csv
import json
import math
import sqlite3
from pathlib import Path
from typing import Dict, Tuple, List, Any

## This automatically ingests marine database.
## NOTE: This is yet experimental.
## This may not be accurate as openflights database.

def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(
        math.radians(lat2)
    ) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return r * c


def load_maritime_data(path: Path) -> Tuple[List[Tuple[str, str, str, float, float, str]], List[Tuple[str, str, float, str, str]]]:
    """
    Loads maritime data from a GeoJSON, returning a list of node tuples and a list of route tuples.
    Handles LineString and MultiLineString geometries.
    """
    nodes_data: List[Tuple[str, str, str, float, float, str]] = [] # (code, name, country, lat, lon, layer)
    routes_data: List[Tuple[str, str, float, str, str]] = [] # (src_code, dst_code, distance_km, layer, path_geojson)

    # Temporary maps for processing
    coord_to_node_code: Dict[Tuple[float, float], str] = {}
    temp_nodes: Dict[str, Tuple[str, str, float, float, str]] = {} # code -> (name, country, lat, lon, layer)

    with path.open("r", encoding="utf-8") as handle:
        geojson_data = json.load(handle)

    # Use a counter for generating unique node codes
    node_counter_val = 0 # Initialize as a simple integer

    # Helper to get/create node, now explicitly returning the updated counter
    def get_or_create_node_helper(coord_tuple: Tuple[float, float], current_node_counter: int) -> Tuple[str, int]:
        if coord_tuple not in coord_to_node_code:
            node_code = f"SEA_NODE_{current_node_counter}"
            current_node_counter += 1
            coord_to_node_code[coord_tuple] = node_code
            temp_nodes[node_code] = (node_code, 'Sea Node', 'Unknown', coord_tuple[1], coord_tuple[0], 'sea')
        return coord_to_node_code[coord_tuple], current_node_counter

    # Helper to process a single LineString's coordinates
    def _process_coordinates_for_linestring(coordinates: List[List[float]], current_node_counter: int, geojson_geometry: Dict[str, Any]) -> int:
        nonlocal routes_data # Allow modification of routes_data from outer scope
        
        if len(coordinates) < 2:
            return current_node_counter

        start_coord_key = tuple(coordinates[0]) # (lon, lat)
        end_coord_key = tuple(coordinates[-1]) # (lon, lat)

        src_code, current_node_counter = get_or_create_node_helper(start_coord_key, current_node_counter)
        dst_code, current_node_counter = get_or_create_node_helper(end_coord_key, current_node_counter)

        total_distance_km = 0.0
        for i in range(len(coordinates) - 1):
            lon1, lat1 = coordinates[i]
            lon2, lat2 = coordinates[i+1]
            total_distance_km += haversine(lat1, lon1, lat2, lon2)
        
        # Note: path_geojson is expected to be a string (JSON representation of the geometry)
        # Ensure the geojson_geometry passed is for the *single* LineString
        routes_data.append((src_code, dst_code, total_distance_km, 'sea', json.dumps(geojson_geometry)))
        return current_node_counter

    for feature in geojson_data.get('features', []):
        geometry_type = feature['geometry']['type']
        geojson_geometry = feature['geometry']

        if geometry_type == 'LineString':
            node_counter_val = _process_coordinates_for_linestring(
                geojson_geometry['coordinates'], node_counter_val, geojson_geometry
            )
        elif geometry_type == 'MultiLineString':
            for line_coords in geojson_geometry['coordinates']:
                # For MultiLineString, each inner array is a LineString's coordinates
                # We need to create a new geometry object for each LineString for path_geojson
                single_linestring_geometry = {"type": "LineString", "coordinates": line_coords}
                node_counter_val = _process_coordinates_for_linestring(
                    line_coords, node_counter_val, single_linestring_geometry
                )

    nodes_data = list(temp_nodes.values())

    return nodes_data, routes_data


def seed_data(conn: sqlite3.Connection,
              nodes_data: List[Tuple[str, str, str, float, float, str]], # code, name, country, lat, lon, layer
              routes_data: List[Tuple[str, str, float, str, str]]) -> None: # src_code, dst_code, distance_km, layer, path_geojson
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
    routes_to_insert_db: List[Tuple[int, int, float, str, str]] = [] # (src_id, dst_id, distance_km, layer, path_geojson)
    for src_code, dst_code, distance_km, layer, path_geojson in routes_data:
        src_id = all_node_code_to_id.get(src_code)
        dst_id = all_node_code_to_id.get(dst_code)
        if src_id is None or dst_id is None:
            print(f"Warning: Missing node ID for route from {src_code} to {dst_code}. Skipping route.")
            continue
        routes_to_insert_db.append((src_id, dst_id, distance_km, layer, path_geojson))

    # Insert new routes (assuming routes are always new for each ingestion run, or handling duplicates if needed)
    # For now, simply insert. A more robust solution might check for existing routes.
    if routes_to_insert_db:
        cur.executemany(
            "INSERT INTO routes (src_id, dst_id, distance_km, layer, path_geojson) VALUES (?, ?, ?, ?, ?);",
            routes_to_insert_db
        )
    conn.commit()


def main():
    parser = argparse.ArgumentParser(description="Ingest maritime GeoJSON data into NukeDB format.")
    parser.add_argument("--geojson", required=True, type=Path, help="Path to maritime GeoJSON file (e.g., Shipping_Lanes_v1.geojson)")
    parser.add_argument("--output", default=Path("data/nuke_routes.db"), type=Path, help="SQLite destination file")
    args = parser.parse_args()

    nodes_data, routes_data = load_maritime_data(args.geojson)
    
    if not nodes_data:
        raise SystemExit("No nodes parsed from maritime GeoJSON.")
    if not routes_data:
        raise SystemExit("No routes parsed from maritime GeoJSON.")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(args.output)
    try:
        seed_data(conn, nodes_data, routes_data)
    finally:
        conn.close()
    print(f"Wrote {len(nodes_data)} sea nodes and {len(routes_data)} sea routes to {args.output}")


if __name__ == "__main__":
    main()
