#include <ctype.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define WASM_KEEPALIVE EMSCRIPTEN_KEEPALIVE
#else
#define WASM_KEEPALIVE
#endif

#include "nuke_flight.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// The global store for WASM
static nuke_flight_store_t g_store;
static bool g_initialized = false;

// We include the .c file here to simplify the WASM build without complex linking for now,
// or we can rely on Makefile to link them. Let's rely on Makefile.

WASM_KEEPALIVE
int nuke_wasm_init(void) {
    if (g_initialized) return 0;
    int rc = nuke_flight_store_init(&g_store, NULL, NULL, 0);
    if (rc == 0) g_initialized = true;
    return rc;
}

WASM_KEEPALIVE
int nuke_wasm_load_data(const void *blob, size_t size) {
    if (!g_initialized) nuke_wasm_init();
    // This function is defined in our modified nuke_flight.c
    extern int nuke_store_load_from_blob(nuke_flight_store_t *store, const void *blob, size_t size);
    return nuke_store_load_from_blob(&g_store, blob, size);
}

WASM_KEEPALIVE
const char* nuke_wasm_get_airports_json(void) {
    if (!g_initialized || g_store.airport_count == 0) return "{\"airports\":[]}";
    
    static char *buffer = NULL;
    static size_t buffer_size = 0;
    
    size_t needed = 128 + g_store.airport_count * 128;
    if (buffer_size < needed) {
        buffer = realloc(buffer, needed);
        buffer_size = needed;
    }
    
    size_t offset = 0;
    offset += sprintf(buffer + offset, "{\"total\":%zu,\"airports\":[", g_store.airport_count);
    for (size_t i = 0; i < g_store.airport_count; ++i) {
        offset += sprintf(buffer + offset, 
            "%s{\"id\":%d,\"code\":\"%s\",\"lat\":%.4f,\"lon\":%.4f}",
            (i == 0 ? "" : ","),
            g_store.airport_ids[i],
            g_store.airport_codes[i],
            g_store.airport_lat[i],
            g_store.airport_lon[i]
        );
    }
    sprintf(buffer + offset, "]}");
    return buffer;
}

WASM_KEEPALIVE
const char* nuke_wasm_search_routes_json(const char *from, const char *to, int max_transfers) {
    if (!g_initialized) return "{\"error\":\"Not initialized\"}";
    
    nuke_search_params_t params = {
        .src_code = from,
        .dst_code = to,
        .max_transfers = max_transfers,
        .max_results = 10
    };
    
    nuke_path_buffer_t result_buffer;
    nuke_path_buffer_init(&result_buffer, 10);
    
    int rc = nuke_search_routes(&g_store, &params, &result_buffer);
    
    static char *output = NULL;
    static size_t output_size = 0;
    size_t needed = 1024 + result_buffer.count * 1024;
    if (output_size < needed) {
        output = realloc(output, needed);
        output_size = needed;
    }
    
    if (rc != 0) {
        sprintf(output, "{\"from\":\"%s\",\"to\":\"%s\",\"results\":0,\"paths\":[],\"error\":%d}", from, to, rc);
        nuke_path_buffer_free(&result_buffer);
        return output;
    }
    
    size_t offset = 0;
    offset += sprintf(output + offset, "{\"from\":\"%s\",\"to\":\"%s\",\"results\":%zu,\"paths\":[", 
                     from, to, result_buffer.count);
    
    for (size_t i = 0; i < result_buffer.count; ++i) {
        nuke_path_result_t *p = &result_buffer.items[i];
        offset += sprintf(output + offset, "%s{\"hops\":%zu,\"legs\":%zu,\"totalDistanceKm\":%.2f,\"greatCircleKm\":%.2f,\"efficiency\":%.4f,\"airports\":[",
                         (i == 0 ? "" : ","), p->hops, p->hops + 1, p->total_distance_km, p->great_circle_km, p->efficiency);
        
        for (size_t j = 0; j < p->airport_count; ++j) {
            offset += sprintf(output + offset, "%s{\"id\":%d,\"code\":\"%s\"}",
                             (j == 0 ? "" : ","), p->airport_ids[j], p->airport_codes[j]);
        }
        offset += sprintf(output + offset, "]}");
    }
    sprintf(output + offset, "]}");
    
    nuke_path_buffer_free(&result_buffer);
    return output;
}

WASM_KEEPALIVE
const char* nuke_wasm_get_health_json(void) {
    static char buffer[256];
    sprintf(buffer, "{\"airports_loaded\":%zu,\"routes_loaded\":%zu,\"nuke_online\":true,\"mode\":\"WASM-Serverless\"}",
            g_store.airport_count, g_store.route_count);
    return buffer;
}

// Keep some of the previous functions if they were useful
WASM_KEEPALIVE
double nuke_wasm_gc_distance(double lat1, double lon1, double lat2, double lon2) {
    // Haversine formula
    double dlat = (lat2 - lat1) * M_PI / 180.0;
    double dlon = (lon2 - lon1) * M_PI / 180.0;
    double a = sin(dlat / 2.0) * sin(dlat / 2.0) +
               cos(lat1 * M_PI / 180.0) * cos(lat2 * M_PI / 180.0) *
                   sin(dlon / 2.0) * sin(dlon / 2.0);
    double c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
    return 6371.0 * c;
}

WASM_KEEPALIVE
double nuke_wasm_calc_score(double lat1, double lon1, double lat2, double lon2, double reliability) {
    double dist = nuke_wasm_gc_distance(lat1, lon1, lat2, lon2);
    if (dist <= 0) return 0;
    return (reliability / (dist + 1.0)) * 1000.0;
}

WASM_KEEPALIVE
double nuke_wasm_route_distance(const double *coords, size_t point_count) {
    if (!coords || point_count < 2) return 0.0;
    double total = 0.0;
    for (size_t i = 1; i < point_count; ++i) {
        total += nuke_wasm_gc_distance(coords[(i-1)*2], coords[(i-1)*2+1], coords[i*2], coords[i*2+1]);
    }
    return total;
}

WASM_KEEPALIVE
double nuke_wasm_efficiency(double gc_distance_km, double actual_distance_km) {
    if (gc_distance_km <= 0.0 || actual_distance_km <= 0.0) return 0.0;
    return (gc_distance_km / actual_distance_km) * 100.0;
}

WASM_KEEPALIVE
int nuke_wasm_is_valid_iata(const char *code) {
    if (!code || strlen(code) != 3) return 0;
    for (int i = 0; i < 3; i++) {
        if (!isalpha((unsigned char)code[i])) return 0;
    }
    return 1;
}

WASM_KEEPALIVE
const char* nuke_wasm_get_best_nodes_json(void) {
    if (!g_initialized || g_store.airport_count == 0)
        return "{\"items\":[]}";

    // Compute hub scores from actual route adjacency data.
    // Score = outbound route count * (1 / average distance), so highly
    // connected airports with shorter average legs rank higher.
    typedef struct { size_t idx; double score; size_t connections; double avg_dist; } hub_t;

    size_t n = g_store.airport_count;
    hub_t *hubs = (hub_t *)malloc(n * sizeof(hub_t));
    if (!hubs) return "{\"items\":[]}";

    for (size_t i = 0; i < n; ++i) {
        size_t cnt = g_store.route_counts[i];
        double total_dist = 0.0;
        size_t off = g_store.route_offsets[i];
        for (size_t j = 0; j < cnt; ++j)
            total_dist += g_store.adj_distance[off + j];
        double avg = cnt > 0 ? total_dist / (double)cnt : 0.0;
        hubs[i].idx = i;
        hubs[i].connections = cnt;
        hubs[i].avg_dist = avg;
        hubs[i].score = cnt > 0 ? (double)cnt / (avg + 1.0) : 0.0;
    }

    // Partial selection sort for top 5
    size_t top = n < 5 ? n : 5;
    for (size_t i = 0; i < top; ++i) {
        size_t best = i;
        for (size_t j = i + 1; j < n; ++j)
            if (hubs[j].score > hubs[best].score) best = j;
        if (best != i) { hub_t tmp = hubs[i]; hubs[i] = hubs[best]; hubs[best] = tmp; }
    }

    static char *buffer = NULL;
    static size_t buffer_size = 0;
    size_t needed = 256 + top * 256;
    if (buffer_size < needed) {
        char *tmp = realloc(buffer, needed);
        if (!tmp) { free(hubs); return "{\"items\":[]}"; }
        buffer = tmp;
        buffer_size = needed;
    }

    size_t offset = 0;
    size_t remaining = buffer_size;
    offset += snprintf(buffer + offset, remaining, "{\"items\":[");
    for (size_t i = 0; i < top; ++i) {
        hub_t *h = &hubs[i];
        remaining = buffer_size - offset;
        offset += snprintf(buffer + offset, remaining,
            "%s{\"anchorAirport\":\"%s\",\"lat\":%.4f,\"lon\":%.4f,"
            "\"connections\":%zu,\"avgDistanceKm\":%.1f,\"score\":%.4f}",
            (i == 0 ? "" : ","),
            g_store.airport_codes[h->idx],
            g_store.airport_lat[h->idx],
            g_store.airport_lon[h->idx],
            h->connections, h->avg_dist, h->score);
    }
    remaining = buffer_size - offset;
    snprintf(buffer + offset, remaining, "]}");
    free(hubs);
    return buffer;
}
