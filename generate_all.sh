#!/usr/bin/env bash
# baboship end-to-end asset builder. Downloads datasets, hydrates the SQLite
# graph, exports JSON/bin artifacts, refreshes the static index, and (optionally)
# regenerates the IMP Center lookup table for the postal tracking analyzer.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$ROOT_DIR/.venv-generate"
PYTHON="$VENV_DIR/bin/python"

echo "Running BaboShip Installer Script...Please be patient."

log() {
  printf '[baboship] %s\n' "$*"
}

cleanup() {
  if [[ -n "${VIRTUAL_ENV:-}" ]]; then
    deactivate || true
  fi
  if [[ -d "$VENV_DIR" ]]; then
    log "Removing virtual environment at $VENV_DIR"
    rm -rf "$VENV_DIR"
  fi
}
trap cleanup EXIT

log "Creating virtual environment"
python3 -m venv "$VENV_DIR"
# shellcheck source=/dev/null
source "$VENV_DIR/bin/activate"

log "Upgrading pip inside venv"
"$PYTHON" -m pip install --upgrade pip >/dev/null
if [[ -s "$ROOT_DIR/scripts/requirements.txt" ]]; then
  log "Installing Python requirements"
  "$PYTHON" -m pip install -r "$ROOT_DIR/scripts/requirements.txt"
else
  log "[skip] scripts/requirements.txt is empty, no dependencies to install"
fi

cd "$ROOT_DIR"

run_py() {
  "$PYTHON" "$@"
}

log "Creating NukeDB schema"
run_py scripts/create_db_schema.py --output data/nuke_routes.db

log "Downloading latest OpenFlights dumps"
run_py scripts/download_openflights.py --dest data/raw

log "Ingesting OpenFlights data into data/nuke_routes.db"
run_py scripts/ingest_openflights.py \
  --airports data/raw/airports.dat \
  --routes data/raw/routes.dat \
  --output data/nuke_routes.db

# Maritime (海運) data ingestion is disabled by default because it is an
# experimental beta feature.  Pass --with-maritime to opt in.
WITH_MARITIME=0
for arg in "$@"; do
  if [[ "$arg" == "--with-maritime" ]]; then
    WITH_MARITIME=1
  fi
done

if [[ "$WITH_MARITIME" == "1" ]]; then
  log "Downloading Shipping Lanes GeoJSON (beta)"
  mkdir -p data/raw
  curl -s -o data/raw/Shipping_Lanes_v1.geojson https://raw.githubusercontent.com/newzealandpaul/Shipping-Lanes/main/data/Shipping_Lanes_v1.geojson

  log "Ingesting Maritime data into data/nuke_routes.db (beta)"
  run_py scripts/ingest_maritime.py \
    --geojson data/raw/Shipping_Lanes_v1.geojson \
    --output data/nuke_routes.db
else
  log "[skip] Maritime data ingestion skipped (pass --with-maritime to enable beta)"
fi

log "Exporting airports for static dashboard"
run_py scripts/export_airports_json.py data/nuke_routes.db docs/airports.json

log "Exporting Nuke blob for WASM engine"
mkdir -p docs/wasm
run_py scripts/export_nuke_blob.py data/nuke_routes.db docs/wasm/nuke_blob.bin

log "Rendering static index template"
run_py scripts/generate_static_index.py

if [[ -f "$ROOT_DIR/data/tracking_country_hubs.sql" ]]; then
  log "Compiling tracking country hub hints"
  run_py scripts/generate_country_hubs_header.py --sql "$ROOT_DIR/data/tracking_country_hubs.sql" --header "$ROOT_DIR/include/tracking_country_hubs.h"
else
  log "[skip] data/tracking_country_hubs.sql not found"
fi

IMPC_SOURCE="${IMPC_SOURCE:-}"
if [[ -z "$IMPC_SOURCE" ]]; then
  for candidate in data/impc_nodes.json data/impc_nodes.csv; do
    if [[ -f "$candidate" ]]; then
      IMPC_SOURCE="$candidate"
      break
    fi
  done
fi

if [[ -n "$IMPC_SOURCE" && -f "$IMPC_SOURCE" ]]; then
  log "Generating IMP Center header from $IMPC_SOURCE"
  run_py scripts/generate_impc_header.py "$IMPC_SOURCE" --output include/impc_data.h
else
  log "[skip] IMP Center source (data/impc_nodes.json|csv or IMPC_SOURCE env) not found"
fi

log "All artifacts generated successfully"
