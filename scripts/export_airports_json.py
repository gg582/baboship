import sqlite3
import json
import sys
import os

def export_airports(db_path, out_path):
    if not os.path.exists(db_path):
        print(f"Error: {db_path} not found")
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    cur.execute("SELECT id, code, latitude, longitude, COALESCE(country, '') FROM airports ORDER BY id ASC")
    airports = cur.fetchall()
    
    data = []
    for a in airports:
        data.append({
            "id": a[0],
            "code": a[1],
            "lat": a[2],
            "lon": a[3],
            "country": a[4]
        })

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)

    print(f"Exported {len(data)} airports to {out_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 export_airports_json.py <db_path> <out_path>")
        sys.exit(1)
    export_airports(sys.argv[1], sys.argv[2])
