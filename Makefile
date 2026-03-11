CC = gcc
EMCC ?= emcc

CWIST_DIR := lib/cwist
TTAK_DIR := lib/libttak
# CWIST_LIB := $(CWIST_DIR)/libcwist.a # Removed, as cwist is missing
TTAK_LIB := $(TTAK_DIR)/lib/libttak.a

CFLAGS += -std=c17 -Wall -Wextra -Wpedantic -O3 -g
CFLAGS += -Iinclude
# CFLAGS += -I$(CWIST_DIR)/include # Removed, as cwist headers are missing
CFLAGS += -I$(TTAK_DIR)/include # -I$(CWIST_DIR)/lib/sqlite3

LDFLAGS += -pthread
# LDFLAGS += -L$(CWIST_DIR) # Removed, as cwist is missing
LDFLAGS += -L$(TTAK_DIR)/lib

LDLIBS += -lttak -lssl -lcrypto -luriparser -lcjson -ldl -lm # Removed -lcwist

WASM_BUILD_DIR := build/wasm
WASM_DIST_DIR := docs/wasm
WASM_MODULE := nuke_kernel
WASM_TARGET := $(WASM_DIST_DIR)/$(WASM_MODULE).js

WASM_SRC := wasm/$(WASM_MODULE).c wasm/logistics_engine.c src/nuke_flight.c
WASM_EXPORTS := '["_nuke_wasm_init","_nuke_wasm_load_data","_nuke_wasm_gc_distance","_nuke_wasm_route_distance","_nuke_wasm_efficiency","_nuke_wasm_is_valid_iata","_nuke_wasm_get_best_nodes_json","_nuke_wasm_get_nodes_json","_nuke_wasm_get_health_json","_nuke_wasm_search_routes_json","_nuke_wasm_calc_score","_nuke_wasm_get_direct_destinations_json","_analyze_tracking","_get_idiot_score","_malloc","_free"]'
WASM_RUNTIME_METHODS := '["cwrap","ccall","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","HEAPU8","HEAPF64","allocate","intArrayFromString","ALLOC_NORMAL"]'
WASM_FLAGS := -std=c17 -Wall -Wextra -Wpedantic -O3 -Iinclude -D__EMSCRIPTEN__
WASM_EMFLAGS := -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=\"createNukeKernel\" -s ENVIRONMENT=web,worker -s ALLOW_MEMORY_GROWTH=1 -s NO_EXIT_RUNTIME=1 -s TOTAL_MEMORY=33554432 -s ERROR_ON_UNDEFINED_SYMBOLS=1

# Flight kernel WASM (parcel location estimator)
FK_MODULE := flight_kernel
FK_TARGET := $(WASM_DIST_DIR)/$(FK_MODULE).js
FK_SRC    := wasm/$(FK_MODULE).c
FK_EXPORTS := '["_fk_init","_fk_load_signal_data","_fk_generate_candidates","_fk_compute_eta_distribution","_malloc","_free"]'
FK_RUNTIME_METHODS := '["cwrap","UTF8ToString","stringToUTF8","lengthBytesUTF8","allocate","intArrayFromString","ALLOC_NORMAL"]'
FK_EMFLAGS := -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=\"createFlightKernel\" -s ENVIRONMENT=web,worker -s ALLOW_MEMORY_GROWTH=1 -s NO_EXIT_RUNTIME=1

APP := nukedb_app # Native app name (not built in this configuration)
# SRC := src/nuke_flight.c src/server.c # Removed native app source
# LOGISTICS_SRC := wasm/logistics_engine.c # Not used for native app
# OBJ := $(SRC:src/%.c=build/%.o) build/logistics_engine.o # Removed native object files

.PHONY: all clean run sample-data wasm wasm_clean db-setup # Add db-setup

all: wasm # Only build wasm components

# $(APP): $(OBJ) $(CWIST_LIB) # Removed native app build rule
# 	$(CC) $(LDFLAGS) $(OBJ) -o $@ $(LDLIBS)

# Removed cwist library build rule
# $(CWIST_LIB):
# 	$(MAKE) -C $(CWIST_DIR) LIBTTAK_DIR=../libttak

# run: $(APP) # Removed native app run rule
# 	./$(APP)

sample-data:
	python3 scripts/create_sample_db.py data/nuke_routes.db

clean:
	rm -rf build $(APP) # Removed $(APP) from clean
#	$(MAKE) -C $(CWIST_DIR) clean || true # Removed cwist clean
	$(MAKE) -C $(TTAK_DIR) clean || true

wasm: $(WASM_TARGET) $(FK_TARGET) docs/wasm/nuke_blob.bin docs/airports.json

docs/airports.json: db-setup scripts/export_airports_json.py # Changed dependency from data/nuke_routes.db to db-setup
	python3 scripts/export_airports_json.py data/nuke_routes.db docs/airports.json

docs/index.html: templates/index.html.tmpl scripts/generate_static_index.py
	python3 scripts/generate_static_index.py

docs/wasm/nuke_blob.bin: db-setup scripts/export_nuke_blob.py # Changed dependency from data/nuke_routes.db to db-setup
	@mkdir -p docs/wasm
	python3 scripts/export_nuke_blob.py data/nuke_routes.db docs/wasm/nuke_blob.bin

# Removed the old data/nuke_routes.db target, now handled by db-setup
# data/nuke_routes.db:
# 	$(MAKE) sample-data

db-setup:
	bash generate_all.sh

$(WASM_TARGET): $(WASM_SRC)
	@mkdir -p $(WASM_BUILD_DIR) $(WASM_DIST_DIR)
	$(EMCC) $(WASM_FLAGS) $(WASM_SRC) $(WASM_EMFLAGS) \
		-s EXPORTED_FUNCTIONS=$(WASM_EXPORTS) \
		-s EXPORTED_RUNTIME_METHODS=$(WASM_RUNTIME_METHODS) \
		-o $(WASM_TARGET)

$(FK_TARGET): $(FK_SRC)
	@mkdir -p $(WASM_BUILD_DIR) $(WASM_DIST_DIR)
	$(EMCC) $(WASM_FLAGS) $(FK_SRC) $(FK_EMFLAGS) \
		-s EXPORTED_FUNCTIONS=$(FK_EXPORTS) \
		-s EXPORTED_RUNTIME_METHODS=$(FK_RUNTIME_METHODS) \
		-o $(FK_TARGET)

wasm_clean:
	rm -rf $(WASM_BUILD_DIR) $(WASM_DIST_DIR)
