import sqlite3
import struct
import sys
import os

def export_db(db_path, out_path):
    if not os.path.exists(db_path):
        print(f"Error: {db_path} not found")
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Define layer mapping
    LAYER_TO_INT = {
        'air': 0,
        'sea': 1,
        'land': 2 # Future use for land-based logistics if needed
    }

    # Get nodes
    cur.execute("SELECT id, code, latitude, longitude, COALESCE(country, ''), layer FROM nodes ORDER BY id ASC")
    nodes_data_db = cur.fetchall() # (id, code, lat, lon, country, layer_str)
    node_count = len(nodes_data_db)
    
    # Create id to index mapping for nodes
    id_to_idx = {n[0]: i for i, n in enumerate(nodes_data_db)}

    # Get routes
    cur.execute("SELECT id, src_id, dst_id, distance_km, layer FROM routes ORDER BY src_id ASC")
    routes_data_db = cur.fetchall() # (id, src_id, dst_id, distance_km, layer_str)
    
    print(f"Exporting {node_count} nodes and {len(routes_data_db)} routes...")

    # Prepare node data
    node_ids = []
    node_codes_padded = []
    node_lats = []
    node_lons = []
    node_layers = [] # numerical representation
    node_countries_padded = [] # New: padded country names

    for n in nodes_data_db:
        node_ids.append(n[0])
        code = (n[1][:3].upper() + '\0').encode('ascii')
        if len(code) < 4:
            code = code + b'\0' * (4 - len(code))
        node_codes_padded.append(code)
        node_lats.append(n[2])
        node_lons.append(n[3])
        node_layers.append(LAYER_TO_INT.get(n[5], 0)) # Default to 0 (air) if unknown layer

        country = (n[4][:31].encode('utf-8')) # Limit to 31 chars for null termination
        country_padded = country + b'\0' * (32 - len(country))
        node_countries_padded.append(country_padded)

    # Prepare route data for adjacency list
    # route_offsets[i] will store the starting index in adj_dst_indices for node i
    # route_counts[i] will store the number of routes originating from node i
    route_offsets = [0] * node_count
    route_counts = [0] * node_count
    adj_route_ids = []
    adj_dst_indices = []
    adj_distances = []
    adj_route_layers = [] # numerical representation

    # Group routes by src_node_index
    grouped_routes = [[] for _ in range(node_count)]
    for r in routes_data_db:
        src_id = r[1]
        src_idx = id_to_idx.get(src_id)
        if src_idx is not None:
            dst_id = r[2]
            dst_idx = id_to_idx.get(dst_id)
            if dst_idx is not None:
                # Store (dst_idx, route_id, distance, layer_int)
                grouped_routes[src_idx].append((dst_idx, r[0], r[3], LAYER_TO_INT.get(r[4], 0)))
            # else: Skip routes to unknown destinations

    # Sort routes for each source to ensure deterministic output
    for i in range(node_count):
        grouped_routes[i].sort(key=lambda x: x[0]) # Sort by dst_idx

    current_adj_index = 0
    for i in range(node_count):
        route_offsets[i] = current_adj_index
        route_counts[i] = len(grouped_routes[i])
        for dst_idx, route_id, distance, layer_int in grouped_routes[i]:
            adj_route_ids.append(route_id)
            adj_dst_indices.append(dst_idx)
            adj_distances.append(distance)
            adj_route_layers.append(layer_int)
            current_adj_index += 1

    actual_route_count = len(adj_route_ids) # This might be less than len(routes_data_db) if some routes were skipped

    # Write to binary file
    with open(out_path, 'wb') as f:
        # Header
        f.write(b'NUKE')
        f.write(struct.pack('<I', 3)) # Version 3: includes layer information and country names
        f.write(struct.pack('<I', node_count))
        f.write(struct.pack('<I', actual_route_count))

        # Nodes
        f.write(struct.pack(f'<{node_count}i', *node_ids))
        f.write(struct.pack(f'<{node_count}d', *node_lats))
        f.write(struct.pack(f'<{node_count}d', *node_lons))
        for code_padded in node_codes_padded:
            f.write(code_padded)
        for country_padded in node_countries_padded: # New: Write country names
            f.write(country_padded)
        f.write(struct.pack(f'<{node_count}B', *node_layers)) # Node layers as bytes

        # Routes
        f.write(struct.pack(f'<{node_count}I', *route_offsets))
        f.write(struct.pack(f'<{node_count}I', *route_counts))
        f.write(struct.pack(f'<{actual_route_count}i', *adj_route_ids))
        f.write(struct.pack(f'<{actual_route_count}I', *adj_dst_indices))
        f.write(struct.pack(f'<{actual_route_count}d', *adj_distances))
        f.write(struct.pack(f'<{actual_route_count}B', *adj_route_layers)) # Route layers as bytes

    print(f"Done. Saved to {out_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 export_nuke_blob.py <db_path> <out_path>")
        sys.exit(1)
    export_db(sys.argv[1], sys.argv[2])
