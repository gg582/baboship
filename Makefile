CC = gcc
EMCC ?= emcc
CFLAGS += -std=c17 -Wall -Wextra -Wpedantic -O2 -g
CFLAGS += -Iinclude
CFLAGS += -pthread
LDFLAGS += -pthread
LDLIBS += -lm -ldl -lssl -lcrypto -luriparser -lcjson -lcwist -lttak

WASM_BUILD_DIR := build/wasm
WASM_DIST_DIR := docs/wasm
WASM_MODULE := nuke_kernel
WASM_TARGET := $(WASM_DIST_DIR)/$(WASM_MODULE).js

WASM_SRC := wasm/$(WASM_MODULE).c src/nuke_flight.c
WASM_EXPORTS := '["_nuke_wasm_init","_nuke_wasm_load_data","_nuke_wasm_gc_distance","_nuke_wasm_route_distance","_nuke_wasm_efficiency","_nuke_wasm_is_valid_iata","_nuke_wasm_get_best_nodes_json","_nuke_wasm_get_airports_json","_nuke_wasm_get_health_json","_nuke_wasm_search_routes_json","_nuke_wasm_calc_score","_malloc","_free"]'
WASM_RUNTIME_METHODS := '["cwrap","ccall","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","HEAPU8","HEAPF64","allocate","intArrayFromString","ALLOC_NORMAL"]'
WASM_FLAGS := -std=c17 -Wall -Wextra -Wpedantic -O2 -Iinclude -D__EMSCRIPTEN__
WASM_EMFLAGS := -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=\"createNukeKernel\" -s ENVIRONMENT=web,worker -s ALLOW_MEMORY_GROWTH=1 -s NO_EXIT_RUNTIME=1 -s TOTAL_MEMORY=33554432 -s ERROR_ON_UNDEFINED_SYMBOLS=1

CWIST_DIR := lib/cwist
TTAK_DIR := lib/libttak
CWIST_LIB := $(CWIST_DIR)/libcwist.a
TTAK_LIB := $(TTAK_DIR)/lib/libttak.a

APP := nukedb_app
SRC := src/nuke_flight.c src/server.c
OBJ := $(SRC:src/%.c=build/%.o)

.PHONY: all clean run deps sample-data wasm wasm_clean

all: $(APP)

$(APP): deps $(OBJ)
	$(CC) $(CFLAGS) -o $@ $(OBJ) $(CWIST_LIB) $(TTAK_LIB) $(LDFLAGS) $(LDLIBS)

deps: $(CWIST_LIB) $(TTAK_LIB)

$(CWIST_LIB):
	$(MAKE) -C $(CWIST_DIR) CC=$(CC)

$(TTAK_LIB):
	$(MAKE) -C $(TTAK_DIR) CC=$(CC)

build/%.o: src/%.c
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

wasm: $(WASM_TARGET) docs/wasm/nuke_blob.bin docs/index.html docs/airports.json

docs/airports.json: data/nuke_routes.db scripts/export_airports_json.py
	python3 scripts/export_airports_json.py data/nuke_routes.db docs/airports.json

docs/index.html: templates/index.html.tmpl scripts/generate_static_index.py
	python3 scripts/generate_static_index.py

docs/wasm/nuke_blob.bin: data/nuke_routes.db scripts/export_nuke_blob.py
	@mkdir -p docs/wasm
	python3 scripts/export_nuke_blob.py data/nuke_routes.db docs/wasm/nuke_blob.bin

data/nuke_routes.db:
	$(MAKE) sample-data

$(WASM_TARGET): $(WASM_SRC)
	@mkdir -p $(WASM_BUILD_DIR) $(WASM_DIST_DIR)
	$(EMCC) $(WASM_FLAGS) $(WASM_SRC) $(WASM_EMFLAGS) \
		-s EXPORTED_FUNCTIONS=$(WASM_EXPORTS) \
		-s EXPORTED_RUNTIME_METHODS=$(WASM_RUNTIME_METHODS) \
		-o $(WASM_TARGET)

wasm_clean:
	rm -rf $(WASM_BUILD_DIR) $(WASM_DIST_DIR)