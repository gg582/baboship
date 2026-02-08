#include "nuke_flight.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <ctype.h>
#include <stdatomic.h>
#include <sys/types.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
// Mock ttak/cwist for WASM if not linking full libs
#define ttak_mem_alloc(size, lifetime, now) malloc(size)
#define ttak_mem_free(ptr) free(ptr)
#define ttak_mem_realloc(ptr, size, lifetime, now) realloc(ptr, size)
#define ttak_get_tick_count() 0
#define ttak_mem_tree_init(t)
#define ttak_mem_tree_destroy(t)
#define ttak_mem_tree_add(...) NULL
#endif

#define EARTH_RADIUS_KM 6371.0
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#define NUKE_DEFAULT_WORKERS 4
#define NUKE_STACK_PREALLOC 64

enum {
    CWIST_NUKE_OK = 0,
    NUKE_ERR_INPUT = -1,
    NUKE_ERR_DATA = -2,
    NUKE_ERR_INTERNAL = -3
};

typedef struct {
    size_t airport_idx;
    size_t depth;
    size_t path_len;
    double total_distance;
    size_t airport_indices[NUKE_MAX_AIRPORTS_IN_PATH];
} nuke_route_frame_t;

typedef struct {
    nuke_flight_store_t *store;
    nuke_path_buffer_t *buffer;
    pthread_mutex_t buffer_lock;
    pthread_mutex_t wait_lock;
    pthread_cond_t wait_cond;
    atomic_int pending_jobs;
    atomic_bool stop;
    size_t max_results;
    size_t max_legs;
    size_t dst_idx;
    size_t src_idx;
    double gc_distance;
    const char **forbidden_countries;
    size_t forbidden_count;
} nuke_worker_group_t;

typedef struct {
    nuke_worker_group_t *group;
    size_t adj_index;
} nuke_worker_job_t;

static uint32_t pack_code(const char *code);
static size_t next_pow_two(size_t value);
static double great_circle(double lat1, double lon1, double lat2, double lon2);
#ifndef __EMSCRIPTEN__
static ssize_t find_airport_index_by_id(const nuke_flight_store_t *store, int id);
static int ensure_meta_schema(nuke_flight_store_t *store);
static void record_search(nuke_flight_store_t *store,
                          const char *src_code,
                          const char *dst_code,
                          size_t max_transfers,
                          size_t results);
#endif
static size_t lookup_airport_index(const nuke_flight_store_t *store, uint32_t packed_code);
static void reset_vertical_arrays(nuke_flight_store_t *store);
#ifndef __EMSCRIPTEN__
static void *worker_loop(void *arg);
#endif
static void worker_execute(void *arg);

#ifdef __EMSCRIPTEN__
int nuke_store_load_from_blob(nuke_flight_store_t *store, const void *blob, size_t size) {
    if (!store || !blob || size < 16) return NUKE_ERR_INPUT;
    const uint8_t *p = (const uint8_t *)blob;
    if (memcmp(p, "NUKE", 4) != 0) return NUKE_ERR_DATA;
    p += 4;
    uint32_t version = *(uint32_t *)p; p += 4;
    if (version != 1 && version != 2) return NUKE_ERR_DATA;
    uint32_t airport_count = *(uint32_t *)p; p += 4;
    uint32_t route_count = *(uint32_t *)p; p += 4;

    reset_vertical_arrays(store);
    store->airport_count = airport_count;
    store->route_count = route_count;

    store->airport_ids = malloc(sizeof(int) * airport_count);
    store->airport_lat = malloc(sizeof(double) * airport_count);
    store->airport_lon = malloc(sizeof(double) * airport_count);
    store->airport_codes = malloc(sizeof(char[4]) * airport_count);
    store->airport_countries = malloc(sizeof(char[32]) * airport_count);

    memcpy(store->airport_ids, p, sizeof(int) * airport_count); p += sizeof(int) * airport_count;
    memcpy(store->airport_lat, p, sizeof(double) * airport_count); p += sizeof(double) * airport_count;
    memcpy(store->airport_lon, p, sizeof(double) * airport_count); p += sizeof(double) * airport_count;
    memcpy(store->airport_codes, p, sizeof(char[4]) * airport_count); p += sizeof(char[4]) * airport_count;

    if (version >= 2) {
        memcpy(store->airport_countries, p, sizeof(char[32]) * airport_count);
        p += sizeof(char[32]) * airport_count;
    } else {
        memset(store->airport_countries, 0, sizeof(char[32]) * airport_count);
    }

    store->route_offsets = malloc(sizeof(size_t) * airport_count);
    store->route_counts = malloc(sizeof(size_t) * airport_count);
    store->adj_route_ids = malloc(sizeof(int) * route_count);
    store->adj_dst_indices = malloc(sizeof(size_t) * route_count);
    store->adj_distance = malloc(sizeof(double) * route_count);

    // Read routes – blob stores uint32_t but struct uses size_t; widen
    // element-by-element to stay correct regardless of sizeof(size_t).
    {
        const uint32_t *u32p;

        u32p = (const uint32_t *)p;
        for (uint32_t i = 0; i < airport_count; ++i) store->route_offsets[i] = u32p[i];
        p += sizeof(uint32_t) * airport_count;

        u32p = (const uint32_t *)p;
        for (uint32_t i = 0; i < airport_count; ++i) store->route_counts[i] = u32p[i];
        p += sizeof(uint32_t) * airport_count;
    }
    memcpy(store->adj_route_ids, p, sizeof(int) * route_count); p += sizeof(int) * route_count;
    {
        const uint32_t *u32p = (const uint32_t *)p;
        for (uint32_t i = 0; i < route_count; ++i) store->adj_dst_indices[i] = u32p[i];
        p += sizeof(uint32_t) * route_count;
    }
    memcpy(store->adj_distance, p, sizeof(double) * route_count); p += sizeof(double) * route_count;

    // Rebuild code hash
    store->code_capacity = next_pow_two(store->airport_count * 2);
    store->code_keys = calloc(store->code_capacity, sizeof(uint32_t));
    store->code_indices = malloc(sizeof(size_t) * store->code_capacity);
    memset(store->code_indices, 0xFF, sizeof(size_t) * store->code_capacity);

    for (size_t i = 0; i < store->airport_count; ++i) {
        uint32_t key = pack_code(store->airport_codes[i]);
        if (!key) continue;
        size_t cap = store->code_capacity;
        size_t mask = cap - 1;
        size_t slot = (key * 2654435761u) & mask;
        for (size_t attempt = 0; attempt < cap; ++attempt) {
            if (store->code_keys[slot] == 0) {
                store->code_keys[slot] = key;
                store->code_indices[slot] = i;
                break;
            }
            slot = (slot + 1) & mask;
        }
    }

    return CWIST_NUKE_OK;
}
#endif

int nuke_flight_store_init(nuke_flight_store_t *store,
                           sqlite3 *nuke_db,
                           cwist_db *meta_db,
                           size_t worker_threads) {
    if (!store) return NUKE_ERR_INPUT;
    memset(store, 0, sizeof(*store));

#ifdef __EMSCRIPTEN__
    (void)nuke_db;
    (void)meta_db;
    (void)worker_threads;
    return CWIST_NUKE_OK;
#else
    store->nuke_db = nuke_db;
    store->meta_db = meta_db;
    pthread_mutex_init(&store->meta_lock, NULL);

    ttak_mem_tree_init(&store->mem_tree);
    store->mem_tree_ready = true;

    store->worker_thread_count = worker_threads ? worker_threads : NUKE_DEFAULT_WORKERS;
    store->worker_queue = cwist_io_queue_create(store->worker_thread_count * 64);
    if (!store->worker_queue) {
        return NUKE_ERR_INTERNAL;
    }

    uint64_t now = ttak_get_tick_count();
    store->worker_threads = ttak_mem_alloc(sizeof(pthread_t) * store->worker_thread_count,
                                           __TTAK_UNSAFE_MEM_FOREVER__,
                                           now);
    if (!store->worker_threads) {
        cwist_io_queue_destroy(store->worker_queue);
        store->worker_queue = NULL;
        return NUKE_ERR_INTERNAL;
    }

    size_t spawned = 0;
    for (; spawned < store->worker_thread_count; ++spawned) {
        if (pthread_create(&store->worker_threads[spawned], NULL, worker_loop, store->worker_queue) != 0) {
            store->worker_thread_count = spawned;
            nuke_flight_store_destroy(store);
            return NUKE_ERR_INTERNAL;
        }
    }

    int refresh_rc = nuke_store_refresh(store);
    if (refresh_rc != CWIST_NUKE_OK) {
        nuke_flight_store_destroy(store);
        return refresh_rc;
    }
    return CWIST_NUKE_OK;
#endif
}

void nuke_flight_store_destroy(nuke_flight_store_t *store) {
    if (!store) return;

#ifndef __EMSCRIPTEN__
    if (store->worker_threads) {
        for (size_t i = 0; i < store->worker_thread_count; ++i) {
            pthread_cancel(store->worker_threads[i]);
        }
        for (size_t i = 0; i < store->worker_thread_count; ++i) {
            pthread_join(store->worker_threads[i], NULL);
        }
        ttak_mem_free(store->worker_threads);
        store->worker_threads = NULL;
    }

    if (store->worker_queue) {
        cwist_io_queue_destroy(store->worker_queue);
        store->worker_queue = NULL;
    }

    if (store->mem_tree_ready) {
        ttak_mem_tree_destroy(&store->mem_tree);
        store->mem_tree_ready = false;
    }

    pthread_mutex_destroy(&store->meta_lock);
#endif
    
    reset_vertical_arrays(store);
}

#ifndef __EMSCRIPTEN__
static int fetch_count(sqlite3 *db, const char *sql, int64_t *out) {
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return NUKE_ERR_INTERNAL;
    }
    int rc = sqlite3_step(stmt);
    if (rc == SQLITE_ROW) {
        *out = sqlite3_column_int64(stmt, 0);
    } else {
        sqlite3_finalize(stmt);
        return NUKE_ERR_DATA;
    }
    sqlite3_finalize(stmt);
    return CWIST_NUKE_OK;
}
#endif

static void reset_vertical_arrays(nuke_flight_store_t *store) {
#ifndef __EMSCRIPTEN__
    if (store->mem_tree_ready) {
        ttak_mem_tree_destroy(&store->mem_tree);
        store->mem_tree_ready = false;
    }
#else
    free(store->airport_ids);
    free(store->airport_lat);
    free(store->airport_lon);
    free(store->airport_codes);
    free(store->airport_countries);
    free(store->route_offsets);
    free(store->route_counts);
    free(store->adj_route_ids);
    free(store->adj_dst_indices);
    free(store->adj_distance);
    free(store->code_keys);
    free(store->code_indices);
#endif
    store->airport_count = 0;
    store->airport_ids = NULL;
    store->airport_lat = NULL;
    store->airport_lon = NULL;
    store->airport_codes = NULL;
    store->airport_countries = NULL;
    store->route_count = 0;
    store->route_offsets = NULL;
    store->route_counts = NULL;
    store->adj_route_ids = NULL;
    store->adj_dst_indices = NULL;
    store->adj_distance = NULL;
    store->code_keys = NULL;
    store->code_indices = NULL;
    store->code_capacity = 0;

#ifndef __EMSCRIPTEN__
    ttak_mem_tree_init(&store->mem_tree);
    store->mem_tree_ready = true;
#endif
}

#ifndef __EMSCRIPTEN__
static int load_airports(nuke_flight_store_t *store) {
    int64_t count = 0;
    int rc = fetch_count(store->nuke_db, "SELECT COUNT(*) FROM airports;", &count);
    if (rc != CWIST_NUKE_OK || count <= 0) return NUKE_ERR_DATA;

    uint64_t now = ttak_get_tick_count();
    store->airport_count = (size_t)count;
    store->airport_ids = ttak_mem_alloc(sizeof(int) * store->airport_count, __TTAK_UNSAFE_MEM_FOREVER__, now);
    store->airport_lat = ttak_mem_alloc(sizeof(double) * store->airport_count, __TTAK_UNSAFE_MEM_FOREVER__, now);
    store->airport_lon = ttak_mem_alloc(sizeof(double) * store->airport_count, __TTAK_UNSAFE_MEM_FOREVER__, now);
    store->airport_codes = ttak_mem_alloc(sizeof(char[4]) * store->airport_count, __TTAK_UNSAFE_MEM_FOREVER__, now);
    store->airport_countries = ttak_mem_alloc(sizeof(char[32]) * store->airport_count, __TTAK_UNSAFE_MEM_FOREVER__, now);
    if (!store->airport_ids || !store->airport_lat || !store->airport_lon || !store->airport_codes || !store->airport_countries) {
        return NUKE_ERR_INTERNAL;
    }
    ttak_mem_tree_add(&store->mem_tree, store->airport_ids, sizeof(int) * store->airport_count, 0, true);
    ttak_mem_tree_add(&store->mem_tree, store->airport_lat, sizeof(double) * store->airport_count, 0, true);
    ttak_mem_tree_add(&store->mem_tree, store->airport_lon, sizeof(double) * store->airport_count, 0, true);
    ttak_mem_tree_add(&store->mem_tree, store->airport_codes, sizeof(char[4]) * store->airport_count, 0, true);
    ttak_mem_tree_add(&store->mem_tree, store->airport_countries, sizeof(char[32]) * store->airport_count, 0, true);

    sqlite3_stmt *stmt = NULL;
    const char *sql = "SELECT id, code, latitude, longitude, COALESCE(country, '') FROM airports ORDER BY id ASC;";
    if (sqlite3_prepare_v2(store->nuke_db, sql, -1, &stmt, NULL) != SQLITE_OK) {
        return NUKE_ERR_INTERNAL;
    }
    size_t idx = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        if (idx >= store->airport_count) break;
        store->airport_ids[idx] = sqlite3_column_int(stmt, 0);
        const unsigned char *code_txt = sqlite3_column_text(stmt, 1);
        double lat = sqlite3_column_double(stmt, 2);
        double lon = sqlite3_column_double(stmt, 3);
        const unsigned char *country_txt = sqlite3_column_text(stmt, 4);
        store->airport_lat[idx] = lat;
        store->airport_lon[idx] = lon;

        char code_buf[4] = {0};
        if (code_txt) {
            size_t len = strlen((const char *)code_txt);
            for (size_t c = 0; c < 3 && c < len; ++c) {
                code_buf[c] = (char)toupper(code_txt[c]);
            }
        }
        store->airport_codes[idx][0] = code_buf[0];
        store->airport_codes[idx][1] = code_buf[1];
        store->airport_codes[idx][2] = code_buf[2];
        store->airport_codes[idx][3] = '\0';

        memset(store->airport_countries[idx], 0, 32);
        if (country_txt) {
            snprintf(store->airport_countries[idx], 32, "%s", (const char *)country_txt);
        }
        ++idx;
    }
    sqlite3_finalize(stmt);
    if (idx != store->airport_count) {
        return NUKE_ERR_DATA;
    }

    store->code_capacity = next_pow_two(store->airport_count * 2);
    store->code_keys = ttak_mem_alloc(sizeof(uint32_t) * store->code_capacity, __TTAK_UNSAFE_MEM_FOREVER__, now);
    store->code_indices = ttak_mem_alloc(sizeof(size_t) * store->code_capacity, __TTAK_UNSAFE_MEM_FOREVER__, now);
    if (!store->code_keys || !store->code_indices) {
        return NUKE_ERR_INTERNAL;
    }
    ttak_mem_tree_add(&store->mem_tree, store->code_keys, sizeof(uint32_t) * store->code_capacity, 0, true);
    ttak_mem_tree_add(&store->mem_tree, store->code_indices, sizeof(size_t) * store->code_capacity, 0, true);
    memset(store->code_keys, 0, sizeof(uint32_t) * store->code_capacity);
    memset(store->code_indices, 0xFF, sizeof(size_t) * store->code_capacity);

    for (size_t i = 0; i < store->airport_count; ++i) {
        uint32_t key = pack_code(store->airport_codes[i]);
        if (!key) continue;
        size_t cap = store->code_capacity;
        size_t mask = cap - 1;
        size_t slot = (key * 2654435761u) & mask;
        for (size_t attempt = 0; attempt < cap; ++attempt) {
            if (store->code_keys[slot] == 0) {
                store->code_keys[slot] = key;
                store->code_indices[slot] = i;
                break;
            } else if (store->code_keys[slot] == key) {
                store->code_indices[slot] = i;
                break;
            }
            slot = (slot + 1) & mask;
        }
    }

    return CWIST_NUKE_OK;
}

static int load_routes(nuke_flight_store_t *store) {
    int64_t count = 0;
    int rc = fetch_count(store->nuke_db, "SELECT COUNT(*) FROM routes;", &count);
    if (rc != CWIST_NUKE_OK || count <= 0) return NUKE_ERR_DATA;

    store->route_count = (size_t)count;
    uint64_t now = ttak_get_tick_count();
    store->route_offsets = ttak_mem_alloc(sizeof(size_t) * store->airport_count, __TTAK_UNSAFE_MEM_FOREVER__, now);
    store->route_counts = ttak_mem_alloc(sizeof(size_t) * store->airport_count, __TTAK_UNSAFE_MEM_FOREVER__, now);
    store->adj_route_ids = ttak_mem_alloc(sizeof(int) * store->route_count, __TTAK_UNSAFE_MEM_FOREVER__, now);
    store->adj_dst_indices = ttak_mem_alloc(sizeof(size_t) * store->route_count, __TTAK_UNSAFE_MEM_FOREVER__, now);
    store->adj_distance = ttak_mem_alloc(sizeof(double) * store->route_count, __TTAK_UNSAFE_MEM_FOREVER__, now);

    if (!store->route_offsets || !store->route_counts ||
        !store->adj_route_ids || !store->adj_dst_indices || !store->adj_distance) {
        return NUKE_ERR_INTERNAL;
    }

    ttak_mem_tree_add(&store->mem_tree, store->route_offsets, sizeof(size_t) * store->airport_count, 0, true);
    ttak_mem_tree_add(&store->mem_tree, store->route_counts, sizeof(size_t) * store->airport_count, 0, true);
    ttak_mem_tree_add(&store->mem_tree, store->adj_route_ids, sizeof(int) * store->route_count, 0, true);
    ttak_mem_tree_add(&store->mem_tree, store->adj_dst_indices, sizeof(size_t) * store->route_count, 0, true);
    ttak_mem_tree_add(&store->mem_tree, store->adj_distance, sizeof(double) * store->route_count, 0, true);

    memset(store->route_counts, 0, sizeof(size_t) * store->airport_count);

    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(store->nuke_db, "SELECT src_id FROM routes ORDER BY src_id ASC;", -1, &stmt, NULL) != SQLITE_OK) {
        return NUKE_ERR_INTERNAL;
    }
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        int src_id = sqlite3_column_int(stmt, 0);
        ssize_t idx = find_airport_index_by_id(store, src_id);
        if (idx >= 0) {
            store->route_counts[idx]++;
        }
    }
    sqlite3_finalize(stmt);

    size_t offset = 0;
    for (size_t i = 0; i < store->airport_count; ++i) {
        store->route_offsets[i] = offset;
        offset += store->route_counts[i];
        store->route_counts[i] = 0;
    }

    if (sqlite3_prepare_v2(store->nuke_db,
                           "SELECT id, src_id, dst_id, distance_km "
                           "FROM routes ORDER BY src_id ASC;",
                           -1,
                           &stmt,
                           NULL) != SQLITE_OK) {
        return NUKE_ERR_INTERNAL;
    }

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        int route_id = sqlite3_column_int(stmt, 0);
        int src_id = sqlite3_column_int(stmt, 1);
        int dst_id = sqlite3_column_int(stmt, 2);
        double distance = sqlite3_column_double(stmt, 3);

        ssize_t src_idx = find_airport_index_by_id(store, src_id);
        ssize_t dst_idx = find_airport_index_by_id(store, dst_id);
        if (src_idx < 0 || dst_idx < 0) continue;

        size_t cursor = store->route_offsets[src_idx] + store->route_counts[src_idx];
        if (cursor >= store->route_count) continue;

        store->adj_route_ids[cursor] = route_id;
        store->adj_dst_indices[cursor] = (size_t)dst_idx;
        store->adj_distance[cursor] = distance;
        store->route_counts[src_idx]++;
    }
    sqlite3_finalize(stmt);

    return CWIST_NUKE_OK;
}
#endif

int nuke_store_refresh(nuke_flight_store_t *store) {
    if (!store) return NUKE_ERR_INPUT;
    reset_vertical_arrays(store);
#ifdef __EMSCRIPTEN__
    return CWIST_NUKE_OK;
#else
    int rc = load_airports(store);
    if (rc != CWIST_NUKE_OK) return rc;
    return load_routes(store);
#endif
}

int nuke_path_buffer_init(nuke_path_buffer_t *buffer, size_t capacity) {
    if (!buffer || !capacity) return NUKE_ERR_INPUT;
    uint64_t now = ttak_get_tick_count();
    (void)now;
    buffer->items = ttak_mem_alloc(sizeof(nuke_path_result_t) * capacity,
                                   __TTAK_UNSAFE_MEM_FOREVER__,
                                   now);
    if (!buffer->items) return NUKE_ERR_INTERNAL;
    memset(buffer->items, 0, sizeof(nuke_path_result_t) * capacity);
    buffer->capacity = capacity;
    buffer->count = 0;
    return CWIST_NUKE_OK;
}

void nuke_path_buffer_reset(nuke_path_buffer_t *buffer) {
    if (!buffer) return;
    buffer->count = 0;
    if (buffer->items) {
        memset(buffer->items, 0, sizeof(nuke_path_result_t) * buffer->capacity);
    }
}

void nuke_path_buffer_free(nuke_path_buffer_t *buffer) {
    if (!buffer) return;
    ttak_mem_free(buffer->items);
    buffer->items = NULL;
    buffer->count = 0;
    buffer->capacity = 0;
}

static void append_result_locked(nuke_worker_group_t *group,
                                 const nuke_route_frame_t *frame,
                                 double total_distance) {
    if (group->buffer->count >= group->buffer->capacity) {
        atomic_store(&group->stop, true);
        return;
    }

    // Deduplicate: skip if an identical airport sequence already exists
    // (can happen with iterative deepening across transfer levels)
    for (size_t e = 0; e < group->buffer->count; ++e) {
        nuke_path_result_t *existing = &group->buffer->items[e];
        if (existing->airport_count == frame->path_len) {
            bool same = true;
            for (size_t k = 0; k < frame->path_len; ++k) {
                if (existing->airport_ids[k] != group->store->airport_ids[frame->airport_indices[k]]) {
                    same = false;
                    break;
                }
            }
            if (same) return;
        }
    }

    nuke_path_result_t *slot = &group->buffer->items[group->buffer->count++];
    slot->total_distance_km = total_distance;
    slot->great_circle_km = group->gc_distance;
    slot->efficiency = (total_distance > 0.0 && group->gc_distance > 0.0)
                           ? (group->gc_distance / total_distance)
                           : 0.0;
    slot->hops = frame->depth;
    slot->airport_count = frame->path_len;
    for (size_t i = 0; i < frame->path_len; ++i) {
        size_t idx = frame->airport_indices[i];
        slot->airport_ids[i] = group->store->airport_ids[idx];
        memcpy(slot->airport_codes[i], group->store->airport_codes[idx], 4);
    }

    if (group->buffer->count >= group->max_results) {
        atomic_store(&group->stop, true);
    }
}

static bool is_country_forbidden(const nuke_flight_store_t *store,
                                  size_t airport_idx,
                                  const char **forbidden_countries,
                                  size_t forbidden_count) {
    if (!forbidden_countries || forbidden_count == 0) return false;
    if (airport_idx >= store->airport_count) return false;
    
    const char *airport_country = store->airport_countries[airport_idx];
    if (!airport_country || airport_country[0] == '\0') return false;
    
    for (size_t k = 0; k < forbidden_count; ++k) {
        if (forbidden_countries[k] && strcasecmp(airport_country, forbidden_countries[k]) == 0) {
            return true;
        }
    }
    return false;
}

static void worker_execute(void *arg) {
    nuke_worker_job_t *job = (nuke_worker_job_t *)arg;
    if (!job || !job->group) {
        ttak_mem_free(job);
        return;
    }
    nuke_worker_group_t *group = job->group;
    nuke_flight_store_t *store = group->store;

    size_t adj_index = job->adj_index;
    ttak_mem_free(job);

    if (adj_index >= store->route_count) goto done;
    size_t neighbor_idx = store->adj_dst_indices[adj_index];
    double distance = store->adj_distance[adj_index];
    if (neighbor_idx >= store->airport_count) goto done;

    if (atomic_load(&group->stop)) goto done;

    nuke_route_frame_t base = {0};
    base.airport_idx = neighbor_idx;
    base.depth = 1;
    base.path_len = 2;
    base.total_distance = distance;
    base.airport_indices[0] = group->src_idx;
    base.airport_indices[1] = neighbor_idx;

    size_t stack_cap = NUKE_STACK_PREALLOC;
    uint64_t now = ttak_get_tick_count();
    (void)now;
    nuke_route_frame_t *stack = ttak_mem_alloc(sizeof(nuke_route_frame_t) * stack_cap,
                                               __TTAK_UNSAFE_MEM_FOREVER__,
                                               now);
    if (!stack) goto done;
    size_t top = 0;
    stack[top++] = base;

    while (top > 0) {
        if (atomic_load(&group->stop)) break;
        nuke_route_frame_t frame = stack[--top];

        if (frame.airport_idx == group->dst_idx) {
#ifndef __EMSCRIPTEN__
            pthread_mutex_lock(&group->buffer_lock);
#endif
            append_result_locked(group, &frame, frame.total_distance);
#ifndef __EMSCRIPTEN__
            pthread_mutex_unlock(&group->buffer_lock);
#endif
            continue;
        }

        if (frame.depth >= group->max_legs) continue;

        size_t offset = store->route_offsets[frame.airport_idx];
        size_t degree = store->route_counts[frame.airport_idx];
        for (size_t i = 0; i < degree; ++i) {
            size_t idx = offset + i;
            size_t next_airport = store->adj_dst_indices[idx];
            if (next_airport >= store->airport_count) continue;

            // Check if this airport's country is forbidden
            if (is_country_forbidden(store, next_airport, group->forbidden_countries, group->forbidden_count)) {
                continue;
            }

            bool seen = false;
            for (size_t j = 0; j < frame.path_len; ++j) {
                if (frame.airport_indices[j] == next_airport) {
                    seen = true;
                    break;
                }
            }
            if (seen) continue;

            nuke_route_frame_t next = frame;
            next.airport_idx = next_airport;
            next.depth = frame.depth + 1;
            next.path_len = frame.path_len + 1;
            if (next.path_len > NUKE_MAX_AIRPORTS_IN_PATH) continue;
            next.airport_indices[next.path_len - 1] = next_airport;
            next.total_distance = frame.total_distance + store->adj_distance[idx];

            if (top >= stack_cap) {
                size_t new_cap = stack_cap * 2;
                now = ttak_get_tick_count();
                nuke_route_frame_t *tmp = ttak_mem_realloc(stack,
                                                           new_cap * sizeof(nuke_route_frame_t),
                                                           __TTAK_UNSAFE_MEM_FOREVER__,
                                                           now);
                if (!tmp) {
                    atomic_store(&group->stop, true);
                    break;
                }
                stack = tmp;
                stack_cap = new_cap;
            }
            stack[top++] = next;
        }
    }
    ttak_mem_free(stack);

done:
#ifndef __EMSCRIPTEN__
    if (atomic_fetch_sub(&group->pending_jobs, 1) == 1) {
        pthread_mutex_lock(&group->wait_lock);
        pthread_cond_signal(&group->wait_cond);
        pthread_mutex_unlock(&group->wait_lock);
    }
#else
    (void)0;
#endif
}

#ifndef __EMSCRIPTEN__
static void *worker_loop(void *arg) {
    cwist_io_queue *queue = (cwist_io_queue *)arg;
    pthread_setcancelstate(PTHREAD_CANCEL_ENABLE, NULL);
    pthread_setcanceltype(PTHREAD_CANCEL_DEFERRED, NULL);
    cwist_io_queue_run(queue);
    return NULL;
}
#endif

static int compare_efficiency(const void *a, const void *b) {
    const nuke_path_result_t *pa = a;
    const nuke_path_result_t *pb = b;
    if (pa->hops < pb->hops) return -1;
    if (pa->hops > pb->hops) return 1;
    if (pa->efficiency < pb->efficiency) return 1;
    if (pa->efficiency > pb->efficiency) return -1;
    if (pa->total_distance_km > pb->total_distance_km) return 1;
    if (pa->total_distance_km < pb->total_distance_km) return -1;
    return 0;
}

int nuke_search_routes(nuke_flight_store_t *store,
                       const nuke_search_params_t *params,
                       nuke_path_buffer_t *buffer) {
    if (!store || !params || !buffer || !buffer->items) {
        return NUKE_ERR_INPUT;
    }
    nuke_path_buffer_reset(buffer);
    if (store->airport_count == 0 || store->route_count == 0) {
        return NUKE_ERR_DATA;
    }
    size_t max_transfers = params->max_transfers;
    if (max_transfers > NUKE_MAX_TRANSFERS) {
        max_transfers = NUKE_MAX_TRANSFERS;
    }
    size_t max_results = params->max_results;
    if (max_results == 0 || max_results > buffer->capacity) {
        max_results = buffer->capacity;
    }
    uint32_t src_code = pack_code(params->src_code);
    uint32_t dst_code = pack_code(params->dst_code);
    if (!src_code || !dst_code) return NUKE_ERR_INPUT;

    size_t src_idx = lookup_airport_index(store, src_code);
    size_t dst_idx = lookup_airport_index(store, dst_code);
    if (src_idx == SIZE_MAX || dst_idx == SIZE_MAX) {
        return NUKE_ERR_DATA;
    }

    double gc = great_circle(store->airport_lat[src_idx],
                             store->airport_lon[src_idx],
                             store->airport_lat[dst_idx],
                             store->airport_lon[dst_idx]);

    size_t degree = store->route_counts[src_idx];
    if (degree == 0) {
        nuke_path_buffer_reset(buffer);
        return CWIST_NUKE_OK;
    }

    // Iterative deepening: search from 0 transfers up to max_transfers.
    // This ensures direct flights are discovered first and fill the buffer
    // before longer multi-hop routes are explored.
    for (size_t t = 0; t <= max_transfers; ++t) {
        if (buffer->count >= max_results) break;

#ifdef __EMSCRIPTEN__
        nuke_worker_group_t group = {
            .store = store,
            .buffer = buffer,
            .max_results = max_results,
            .max_legs = t + 1,
            .dst_idx = dst_idx,
            .src_idx = src_idx,
            .gc_distance = gc,
            .forbidden_countries = params->forbidden_countries,
            .forbidden_count = params->forbidden_count
        };
        atomic_store(&group.pending_jobs, 0);
        atomic_store(&group.stop, false);

        size_t start = store->route_offsets[src_idx];
        for (size_t i = 0; i < degree; ++i) {
            if (atomic_load(&group.stop)) break;
            nuke_worker_job_t *pjob = malloc(sizeof(nuke_worker_job_t));
            pjob->group = &group;
            pjob->adj_index = start + i;
            worker_execute(pjob);
        }
#else
        nuke_worker_group_t group = {
            .store = store,
            .buffer = buffer,
            .max_results = max_results,
            .max_legs = t + 1,
            .dst_idx = dst_idx,
            .src_idx = src_idx,
            .gc_distance = gc,
            .forbidden_countries = params->forbidden_countries,
            .forbidden_count = params->forbidden_count
        };
        pthread_mutex_init(&group.buffer_lock, NULL);
        pthread_mutex_init(&group.wait_lock, NULL);
        pthread_cond_init(&group.wait_cond, NULL);
        atomic_store(&group.pending_jobs, 0);
        atomic_store(&group.stop, false);

        size_t start = store->route_offsets[src_idx];
        size_t jobs = degree;
        for (size_t i = 0; i < jobs; ++i) {
            uint64_t job_now = ttak_get_tick_count();
            nuke_worker_job_t *job = ttak_mem_alloc(sizeof(nuke_worker_job_t),
                                                    __TTAK_UNSAFE_MEM_FOREVER__,
                                                    job_now);
            if (!job) continue;
            job->group = &group;
            job->adj_index = start + i;
            atomic_fetch_add(&group.pending_jobs, 1);
            if (!cwist_io_queue_submit(store->worker_queue, worker_execute, job)) {
                ttak_mem_free(job);
                atomic_fetch_sub(&group.pending_jobs, 1);
            }
        }

        pthread_mutex_lock(&group.wait_lock);
        while (atomic_load(&group.pending_jobs) > 0) {
            pthread_cond_wait(&group.wait_cond, &group.wait_lock);
        }
        pthread_mutex_unlock(&group.wait_lock);

        pthread_mutex_destroy(&group.buffer_lock);
        pthread_mutex_destroy(&group.wait_lock);
        pthread_cond_destroy(&group.wait_cond);
#endif
    }

    if (buffer->count > 1) {
        qsort(buffer->items, buffer->count, sizeof(nuke_path_result_t), compare_efficiency);
    }

#ifndef __EMSCRIPTEN__
    record_search(store, params->src_code, params->dst_code, max_transfers, buffer->count);
#endif
    return CWIST_NUKE_OK;
}

static uint32_t pack_code(const char *code) {
    if (!code) return 0;
    if (strlen(code) < 3) return 0;
    char norm[4] = {0};
    for (size_t i = 0; i < 3; ++i) {
        char c = (char)toupper((unsigned char)code[i]);
        if (!isalnum((unsigned char)c)) {
            return 0;
        }
        norm[i] = c;
    }
    norm[3] = ' ';
    return ((uint32_t)norm[0] << 24) |
           ((uint32_t)norm[1] << 16) |
           ((uint32_t)norm[2] << 8) |
           (uint32_t)norm[3];
}

static size_t next_pow_two(size_t value) {
    if (value <= 1) return 1;
    value--;
    value |= value >> 1;
    value |= value >> 2;
    value |= value >> 4;
    value |= value >> 8;
    value |= value >> 16;
#if SIZE_MAX > UINT32_MAX
    value |= value >> 32;
#endif
    return value + 1;
}

#ifndef __EMSCRIPTEN__
static ssize_t find_airport_index_by_id(const nuke_flight_store_t *store, int id) {
    size_t left = 0;
    size_t right = store->airport_count;
    while (left < right) {
        size_t mid = left + (right - left) / 2;
        int mid_id = store->airport_ids[mid];
        if (mid_id == id) return (ssize_t)mid;
        if (mid_id < id) left = mid + 1;
        else right = mid;
    }
    return -1;
}
#endif

static size_t lookup_airport_index(const nuke_flight_store_t *store, uint32_t packed_code) {
    if (!packed_code || store->code_capacity == 0) return SIZE_MAX;
    size_t mask = store->code_capacity - 1;
    size_t slot = (packed_code * 2654435761u) & mask;
    for (size_t attempt = 0; attempt < store->code_capacity; ++attempt) {
        if (store->code_keys[slot] == packed_code) {
            size_t idx = store->code_indices[slot];
            return (idx < store->airport_count) ? idx : SIZE_MAX;
        }
        if (store->code_keys[slot] == 0) break;
        slot = (slot + 1) & mask;
    }
    return SIZE_MAX;
}

bool nuke_store_has_airport(const nuke_flight_store_t *store, const char code[4]) {
    if (!store || !code) return false;
    uint32_t packed = pack_code(code);
    if (!packed) return false;
    return lookup_airport_index(store, packed) != SIZE_MAX;
}

static double great_circle(double lat1, double lon1, double lat2, double lon2) {
    double dlat = (lat2 - lat1) * M_PI / 180.0;
    double dlon = (lon2 - lon1) * M_PI / 180.0;
    double a = sin(dlat / 2.0) * sin(dlat / 2.0) +
               cos(lat1 * M_PI / 180.0) * cos(lat2 * M_PI / 180.0) *
                   sin(dlon / 2.0) * sin(dlon / 2.0);
    double c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
    return EARTH_RADIUS_KM * c;
}

#ifndef __EMSCRIPTEN__
static int ensure_meta_schema(nuke_flight_store_t *store) {
    if (!store || !store->meta_db) return CWIST_NUKE_OK;
    const char *ddl =
        "CREATE TABLE IF NOT EXISTS search_audit ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "src_code TEXT NOT NULL,"
        "dst_code TEXT NOT NULL,"
        "max_transfers INTEGER NOT NULL,"
        "results INTEGER NOT NULL,"
        "created_at DATETIME DEFAULT CURRENT_TIMESTAMP"
        ");";
    return sqlite3_exec(store->meta_db->conn, ddl, NULL, NULL, NULL) == SQLITE_OK
               ? CWIST_NUKE_OK
               : NUKE_ERR_INTERNAL;
}

static void record_search(nuke_flight_store_t *store,
                          const char *src_code,
                          const char *dst_code,
                          size_t max_transfers,
                          size_t results) {
    if (!store || !store->meta_db) return;
    pthread_mutex_lock(&store->meta_lock);
    if (ensure_meta_schema(store) != CWIST_NUKE_OK) {
        pthread_mutex_unlock(&store->meta_lock);
        return;
    }
    const char *sql =
        "INSERT INTO search_audit (src_code, dst_code, max_transfers, results) "
        "VALUES (?, ?, ?, ?);";
    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(store->meta_db->conn, sql, -1, &stmt, NULL) != SQLITE_OK) {
        pthread_mutex_unlock(&store->meta_lock);
        return;
    }
    sqlite3_bind_text(stmt, 1, src_code, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, dst_code, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 3, (int)max_transfers);
    sqlite3_bind_int(stmt, 4, (int)results);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    pthread_mutex_unlock(&store->meta_lock);
}
#endif
