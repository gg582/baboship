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

    # Get airports
    cur.execute("SELECT id, code, latitude, longitude, COALESCE(country, '') FROM airports ORDER BY id ASC")
    airports = cur.fetchall()
    airport_count = len(airports)
    
    # Create id to index mapping
    id_to_idx = {a[0]: i for i, a in enumerate(airports)}

    # Get routes
    cur.execute("SELECT id, src_id, dst_id, distance_km FROM routes ORDER BY src_id ASC")
    routes = cur.fetchall()
    route_count = len(routes)

    print(f"Exporting {airport_count} airports and {route_count} routes...")

    # Prepare data
    airport_ids = []
    airport_codes = []
    airport_lats = []
    airport_lons = []
    airport_countries = []
    for a in airports:
        airport_ids.append(a[0])
        code = (a[1][:3].upper() + '\0').encode('ascii')
        if len(code) < 4:
            code = code + b'\0' * (4 - len(code))
        airport_codes.append(code)
        airport_lats.append(a[2])
        airport_lons.append(a[3])
        country = (a[4] if len(a) > 4 else "")[:31]
        country_bytes = country.encode('utf-8')[:31].ljust(32, b'\0')
        airport_countries.append(country_bytes)

    route_offsets = [0] * airport_count
    route_counts = [0] * airport_count
    adj_route_ids = []
    adj_dst_indices = []
    adj_distances = []

    # Group routes by src_id
    current_offset = 0
    for i, a in enumerate(airports):
        src_id = a[0]
        # This is inefficient but okay for sample data
        src_routes = [r for r in routes if r[1] == src_id]
        route_offsets[i] = current_offset
        route_counts[i] = len(src_routes)
        for r in src_routes:
            dst_id = r[2]
            if dst_id in id_to_idx:
                adj_route_ids.append(r[0])
                adj_dst_indices.append(id_to_idx[dst_id])
                adj_distances.append(r[3])
                current_offset += 1
            else:
                # Skip routes to unknown airports
                route_counts[i] -= 1

    actual_route_count = len(adj_route_ids)

    # Write to binary file
    with open(out_path, 'wb') as f:
        # Header
        f.write(b'NUKE')
        f.write(struct.pack('<I', 2)) # Version 2: includes country
        f.write(struct.pack('<I', airport_count))
        f.write(struct.pack('<I', actual_route_count))

        # Airports
        f.write(struct.pack(f'<{airport_count}i', *airport_ids))
        f.write(struct.pack(f'<{airport_count}d', *airport_lats))
        f.write(struct.pack(f'<{airport_count}d', *airport_lons))
        for code in airport_codes:
            f.write(code)
        for country in airport_countries:
            f.write(country)

        # Routes
        f.write(struct.pack(f'<{airport_count}I', *route_offsets))
        f.write(struct.pack(f'<{airport_count}I', *route_counts))
        f.write(struct.pack(f'<{actual_route_count}i', *adj_route_ids))
        f.write(struct.pack(f'<{actual_route_count}I', *adj_dst_indices))
        f.write(struct.pack(f'<{actual_route_count}d', *adj_distances))

    print(f"Done. Saved to {out_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 export_nuke_blob.py <db_path> <out_path>")
        sys.exit(1)
    export_db(sys.argv[1], sys.argv[2])
