#ifndef NUKE_FLIGHT_H
#define NUKE_FLIGHT_H

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>
#include <sqlite3.h>
#include <pthread.h>

#include <cwist/core/db/sql.h>
#include <cwist/sys/io/cwist_io.h>
#include <ttak/mem_tree/mem_tree.h>
#include <ttak/mem/mem.h>
#include <ttak/timing/timing.h>

#define NUKE_MAX_TRANSFERS 3
#define NUKE_MAX_LEGS (NUKE_MAX_TRANSFERS + 1)
#define NUKE_MAX_AIRPORTS_IN_PATH (NUKE_MAX_LEGS + 1)

typedef struct nuke_flight_store nuke_flight_store_t;

typedef struct {
    const char *src_code;
    const char *dst_code;
    size_t max_transfers;
    size_t max_results;
} nuke_search_params_t;

typedef struct {
    int airport_ids[NUKE_MAX_AIRPORTS_IN_PATH];
    char airport_codes[NUKE_MAX_AIRPORTS_IN_PATH][4];
    size_t airport_count;
    size_t hops;
    double total_distance_km;
    double great_circle_km;
    double efficiency;
} nuke_path_result_t;

typedef struct {
    nuke_path_result_t *items;
    size_t count;
    size_t capacity;
} nuke_path_buffer_t;

struct nuke_flight_store {
    sqlite3 *nuke_db;
    cwist_db *meta_db;
    pthread_mutex_t meta_lock;

    // Memory discipline
    ttak_mem_tree_t mem_tree;
    bool mem_tree_ready;

    // Airport vertical arrays
    size_t airport_count;
    int *airport_ids;
    double *airport_lat;
    double *airport_lon;
    char (*airport_codes)[4];

    // Code lookup hash
    uint32_t *code_keys;
    size_t *code_indices;
    size_t code_capacity;

    // Route adjacency
    size_t route_count;
    size_t *route_offsets;
    size_t *route_counts;
    int *adj_route_ids;
    size_t *adj_dst_indices;
    double *adj_distance;

    // Worker pool
    cwist_io_queue *worker_queue;
    pthread_t *worker_threads;
    size_t worker_thread_count;
};

int nuke_flight_store_init(nuke_flight_store_t *store,
                           sqlite3 *nuke_db,
                           cwist_db *meta_db,
                           size_t worker_threads);

void nuke_flight_store_destroy(nuke_flight_store_t *store);

int nuke_store_refresh(nuke_flight_store_t *store);

int nuke_path_buffer_init(nuke_path_buffer_t *buffer, size_t capacity);
void nuke_path_buffer_reset(nuke_path_buffer_t *buffer);
void nuke_path_buffer_free(nuke_path_buffer_t *buffer);

int nuke_search_routes(nuke_flight_store_t *store,
                       const nuke_search_params_t *params,
                       nuke_path_buffer_t *buffer);

bool nuke_store_has_airport(const nuke_flight_store_t *store, const char code[4]);

#endif
