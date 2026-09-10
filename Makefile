CC = gcc
EMCC ?= emcc

CWIST_DIR := lib/cwist
TTAK_DIR := lib/libttak
CWIST_LIB := $(CWIST_DIR)/libcwist.a
TTAK_LIB := $(TTAK_DIR)/lib/libttak.a

CFLAGS += -std=c17 -Wall -Wextra -Wpedantic -O3 -g -D_GNU_SOURCE
CFLAGS += -Iinclude -I$(CWIST_DIR)/include -I$(TTAK_DIR)/include -I$(CWIST_DIR)/lib/cjson -I$(CWIST_DIR)/lib/sqlite3 -I$(CWIST_DIR)/lib/uriparser/include

LDFLAGS += -pthread -L$(CWIST_DIR) -L$(TTAK_DIR)/lib

LDLIBS += $(CWIST_LIB) $(TTAK_LIB) $(CWIST_DIR)/lib/cjson/libcjson.a $(CWIST_DIR)/lib/uriparser/build/liburiparser.a $(CWIST_DIR)/lib/lsquic/build/src/liblsquic/liblsquic.a $(CWIST_DIR)/lib/boringssl/build/libssl.a $(CWIST_DIR)/lib/boringssl/build/libcrypto.a -lcurl -lnghttp2 -lbrotlienc -lbrotlicommon -lbrotlidec -lzstd -lssl -lcrypto -ldl -lm -lstdc++ -lz -pthread

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

APP := nukedb_app
SRC := src/nuke_flight.c src/server.c wasm/logistics_engine.c
OBJ := $(patsubst %.c,build/%.o,$(SRC))

.PHONY: all clean run sample-data wasm wasm_clean db-setup

all: wasm

$(APP): $(OBJ) $(CWIST_LIB) $(TTAK_LIB)
	$(CC) $(CFLAGS) $(OBJ) -o $@ $(LDFLAGS) $(LDLIBS)

build/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

run: $(APP)
	./$(APP)

sample-data:
	python3 scripts/create_sample_db.py data/nuke_routes.db

clean:
	rm -rf build $(APP)
	$(MAKE) -C $(CWIST_DIR) clean || true
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
