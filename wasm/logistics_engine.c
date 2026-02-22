#include <ctype.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

#include "nuke_flight.h"
#include "logistics_engine.h"
#include "tracking_country_hubs.h"

#if defined(__has_include)
#  if __has_include("impc_data.h")
#    include "impc_data.h"
#    define HAS_IMPC_DATA 1
#  endif
#endif
#ifndef HAS_IMPC_DATA
#define HAS_IMPC_DATA 0
#endif

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define WASM_KEEPALIVE EMSCRIPTEN_KEEPALIVE
#else
#define WASM_KEEPALIVE
#endif

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

typedef struct {
    const char *ptr;
    size_t len;
} strview_t;

#define MAX_LOG_TOKENS 64
#define MAX_ROUTE_NODES 16
#define RESULT_BUFFER_SIZE 2048
#define DWELL_THRESHOLD_SECONDS (6ULL * 3600ULL)
#define ROUTE_DEVIATION_DIVISOR 3.5f

typedef struct {
    const char *alias;
    const char *iata;
} location_alias_t;

typedef struct {
    const char *city;
    const char *iata;
} impc_city_hint_t;

typedef struct {
    const char *iso;
    const char *iata;
} impc_country_hint_t;

typedef struct {
    strview_t tokens[MAX_LOG_TOKENS];
    size_t token_count;
    uint64_t timestamps[MAX_LOG_TOKENS];
    size_t time_count;
} log_parse_result_t;

typedef struct {
    char iata[4];
    float lat;
    float lon;
    uint64_t timestamp;
} route_node_t;

typedef struct {
    route_node_t nodes[MAX_ROUTE_NODES];
    size_t node_count;
    float dwell_penalty;
    float route_penalty;
    float total_distance;
    float direct_distance;
    float edi_score;
} edi_state_t;

static const location_alias_t g_aliases[] = {
    {"INCHEON", "ICN"},
    {"INCHON", "ICN"},
    {"SEOUL", "ICN"},
    {"GIMPO", "GMP"},
    {"DAEGU", "TAE"},
    {"LOSANGELES", "LAX"},
    {"LOS-ANGELES", "LAX"},
    {"FRANKFURT", "FRA"},
    {"PUDONG", "PVG"},
    {"SHANGHAI", "PVG"},
    {"SINGAPORE", "SIN"},
    {"HONGKONG", "HKG"},
    {"CHEKLA", "HKG"}
};
static const size_t g_alias_count = sizeof(g_aliases) / sizeof(g_aliases[0]);

static const impc_city_hint_t g_impc_city_hints[] = {
    {"BJS", "PEK"},
    {"OSA", "KIX"},
    {"PAR", "CDG"},
    {"ROM", "FCO"},
    {"SEL", "ICN"},
    {"SHA", "PVG"},
    {"TYO", "NRT"},
    {"NYC", "JFK"},
    {"CHI", "ORD"},
    {"LON", "LHR"},
    {"MOW", "SVO"},
    {"BER", "BER"},
    {"AMS", "AMS"}
};
static const size_t g_impc_city_hint_count = sizeof(g_impc_city_hints) / sizeof(g_impc_city_hints[0]);

static const impc_country_hint_t g_impc_country_hints[] = {
    {"AE", "DXB"},
    {"AU", "SYD"},
    {"BR", "GRU"},
    {"CA", "YYZ"},
    {"CN", "PVG"},
    {"DE", "FRA"},
    {"FR", "CDG"},
    {"GB", "LHR"},
    {"HK", "HKG"},
    {"HU", "BUD"},
    {"IN", "DEL"},
    {"IT", "FCO"},
    {"JP", "NRT"},
    {"KR", "ICN"},
    {"NL", "AMS"},
    {"QA", "DOH"},
    {"RU", "SVO"},
    {"SG", "SIN"},
    {"TH", "BKK"},
    {"TR", "IST"},
    {"US", "JFK"},
    {"ZA", "JNB"}
};
static const size_t g_impc_country_hint_count = sizeof(g_impc_country_hints) / sizeof(g_impc_country_hints[0]);

static edi_state_t g_state;
static char g_result_buffer[RESULT_BUFFER_SIZE];

static inline size_t min_size(size_t a, size_t b) { return a < b ? a : b; }
static size_t copy_upper(const char *src, size_t len, char *dst, size_t cap) {
    size_t actual = min_size(len, cap - 1);
    for (size_t i = 0; i < actual; ++i) {
        dst[i] = (char)toupper((unsigned char)src[i]);
    }
    dst[actual] = '\0';
    return actual;
}

extern const nuke_flight_store_t* nuke_wasm_get_store(void);
#ifndef __EMSCRIPTEN__
const nuke_flight_store_t* logistics_native_get_store(void);
#endif

static const nuke_flight_store_t* logistics_get_store(void) {
#ifdef __EMSCRIPTEN__
    return nuke_wasm_get_store();
#else
    return logistics_native_get_store();
#endif
}

static bool lookup_node_coords(const char *code, route_node_t *out) { // Renamed from lookup_airport_coords
    if (!code || !out) return false;
    const nuke_flight_store_t *store = logistics_get_store();
    if (!store || !store->node_codes || store->node_count == 0) return false; // Renamed airport_codes to node_codes, airport_count to node_count

    char target[4] = {0};
    size_t written = 0;
    for (; written < 3 && code[written]; ++written) {
        target[written] = (char)toupper((unsigned char)code[written]);
    }
    if (written != 3) return false;

    for (size_t i = 0; i < store->node_count; ++i) { // Renamed airport_count to node_count
        const char *candidate = store->node_codes[i]; // Renamed airport_codes to node_codes
        if (!candidate || candidate[0] == '\0') continue;
        if (strncasecmp(target, candidate, 3) == 0) {
            memcpy(out->iata, candidate, 3);
            out->iata[3] = '\0';
            out->lat = (float)store->node_lat[i]; // Renamed airport_lat to node_lat
            out->lon = (float)store->node_lon[i]; // Renamed airport_lon to node_lon
            return true;
        }
    }
    return false;
}

static const char* lookup_alias_code(strview_t token) {
    char buffer[32];
    size_t len = copy_upper(token.ptr, token.len, buffer, sizeof(buffer));
    if (len == 0) return NULL;
    for (size_t i = 0; i < g_alias_count; ++i) {
        if (strncmp(buffer, g_aliases[i].alias, len) == 0 && g_aliases[i].alias[len] == '\0') {
            return g_aliases[i].iata;
        }
    }
    return NULL;
}

static const tracking_country_hub_t* lookup_country_hub(const char iso[3]) {
    size_t lo = 0;
    size_t hi = TRACKING_COUNTRY_HUB_COUNT;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        int cmp = strncmp(iso, TRACKING_COUNTRY_HUBS[mid].iso, 2);
        if (cmp == 0) {
            return &TRACKING_COUNTRY_HUBS[mid];
        }
        if (cmp < 0) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return NULL;
}

static bool resolve_country_code_token(const char upper[3], route_node_t *out) {
    if (!upper || !out) return false;
    for (size_t i = 0; i < 2; ++i) {
        if (!isalpha((unsigned char)upper[i])) {
            return false;
        }
    }
    char iso[3] = {upper[0], upper[1], '\0'};
    const tracking_country_hub_t *hub = lookup_country_hub(iso);
    if (!hub) return false;
    return lookup_node_coords(hub->iata, out); // Renamed lookup_airport_coords to lookup_node_coords
}

#if HAS_IMPC_DATA
static bool lookup_impc_table(const char *code, route_node_t *out) {
    size_t lo = 0;
    size_t hi = IMPC_TABLE_SIZE;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        int cmp = strncmp(code, IMPC_TABLE[mid].impc, 6);
        if (cmp == 0) {
            const impc_mapping_t *entry = &IMPC_TABLE[mid];
            memcpy(out->iata, entry->iata, 3);
            out->iata[3] = '\0';
            out->lat = entry->lat;
            out->lon = entry->lon;
            return true;
        }
        if (cmp < 0) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return false;
}
#endif

static const char* lookup_impc_city_hint(const char city[4]) {
    for (size_t i = 0; i < g_impc_city_hint_count; ++i) {
        if (strncmp(city, g_impc_city_hints[i].city, 3) == 0) {
            return g_impc_city_hints[i].iata;
        }
    }
    return NULL;
}

static const char* lookup_impc_country_hint(const char iso[3]) {
    for (size_t i = 0; i < g_impc_country_hint_count; ++i) {
        if (strncmp(iso, g_impc_country_hints[i].iso, 2) == 0) {
            return g_impc_country_hints[i].iata;
        }
    }
    return NULL;
}

static bool resolve_impc_token(const char *upper, size_t len, route_node_t *out) {
    if (len != 6) return false;
    for (size_t i = 0; i < len; ++i) {
        if (!isalpha((unsigned char)upper[i])) return false;
    }
    char iso[3] = {upper[0], upper[1], '\0'};
    char city[4] = {upper[2], upper[3], upper[4], '\0'};

#if HAS_IMPC_DATA
    if (lookup_impc_table(upper, out)) return true;
#endif

    if (lookup_node_coords(city, out)) return true; // Renamed lookup_airport_coords to lookup_node_coords

    const char *city_hint = lookup_impc_city_hint(city);
    if (city_hint && lookup_node_coords(city_hint, out)) return true; // Renamed lookup_airport_coords to lookup_node_coords

    const char *country_hint = lookup_impc_country_hint(iso);
    if (country_hint && lookup_node_coords(country_hint, out)) return true; // Renamed lookup_airport_coords to lookup_node_coords

    return false;
}

static bool is_location_char(int ch) {
    return isalpha(ch) || ch == '-' || ch == '_';
}

static bool is_timestamp_char(int ch) {
    return isdigit(ch);
}

static void push_token(log_parse_result_t *out, const char *ptr, size_t len) {
    if (len < 2 || out->token_count >= MAX_LOG_TOKENS) return;
    out->tokens[out->token_count++] = (strview_t){ptr, len};
}

static void push_timestamp(log_parse_result_t *out, uint64_t value) {
    if (out->time_count >= MAX_LOG_TOKENS) return;
    out->timestamps[out->time_count++] = value;
}

static uint64_t parse_decimal(const char *ptr, size_t len) {
    uint64_t value = 0;
    for (size_t i = 0; i < len; ++i) {
        if (!isdigit((unsigned char)ptr[i])) break;
        value = value * 10u + (uint64_t)(ptr[i] - '0');
    }
    return value;
}

static void log_normalize(const char *raw, log_parse_result_t *out) {
    out->token_count = 0;
    out->time_count = 0;
    if (!raw) return;
    size_t len = strlen(raw);
    size_t idx = 0;
    size_t token_start = 0;
    bool in_token = false;
    size_t digit_start = 0;
    bool in_digits = false;

    while (idx < len) {
        char ch = raw[idx];
        if (is_location_char((unsigned char)ch)) {
            if (!in_token) {
                in_token = true;
                token_start = idx;
            }
        } else {
            if (in_token) {
                push_token(out, raw + token_start, idx - token_start);
                in_token = false;
            }
        }

        if (is_timestamp_char((unsigned char)ch)) {
            if (!in_digits) {
                in_digits = true;
                digit_start = idx;
            }
        } else {
            if (in_digits) {
                size_t digit_len = idx - digit_start;
                if (digit_len >= 6) {
                    push_timestamp(out, parse_decimal(raw + digit_start, digit_len));
                }
                in_digits = false;
            }
        }

        ++idx;
    }
    if (in_token) push_token(out, raw + token_start, len - token_start);
    if (in_digits && len - digit_start >= 6) {
        push_timestamp(out, parse_decimal(raw + digit_start, len - digit_start));
    }
}

static bool resolve_token_to_node(strview_t token, route_node_t *out) {
    if (!out) return false;
    char buffer[16];
    size_t len = copy_upper(token.ptr, token.len, buffer, sizeof(buffer));
    if (len < 2) return false;

    if (resolve_impc_token(buffer, len, out)) return true;

    if (len == 2 && resolve_country_code_token(buffer, out)) return true;

    if (len == 3 && lookup_node_coords(buffer, out)) return true; // Renamed lookup_airport_coords to lookup_node_coords

    const char *alias_code = lookup_alias_code((strview_t){buffer, len});
    if (alias_code && lookup_node_coords(alias_code, out)) return true; // Renamed lookup_airport_coords to lookup_node_coords

    const char *dash = strchr(buffer, '-');
    if (dash && strlen(dash + 1) == 3) {
        if (lookup_node_coords(dash + 1, out)) return true; // Renamed lookup_airport_coords to lookup_node_coords
    }

    if (len > 3) {
        for (size_t i = 0; i + 3 <= len; ++i) {
            if (!isalpha((unsigned char)buffer[i]) ||
                !isalpha((unsigned char)buffer[i + 1]) ||
                !isalpha((unsigned char)buffer[i + 2])) {
                continue;
            }
            char window[4] = {
                buffer[i],
                buffer[i + 1],
                buffer[i + 2],
                '\0'
            };
            if (lookup_node_coords(window, out)) return true; // Renamed lookup_airport_coords to lookup_node_coords
        }
    }

    return false;
}

static float great_circle(float lat1, float lon1, float lat2, float lon2) {
    const float rad = (float)(M_PI / 180.0);
    float t1 = lat1 * rad;
    float t2 = lat2 * rad;
    float dlat = (lat2 - lat1) * rad;
    float dlon = (lon2 - lon1) * rad;
    float sin_dlat = sinf(dlat / 2.0f);
    float sin_dlon = sinf(dlon / 2.0f);
    float a = sin_dlat * sin_dlat + cosf(t1) * cosf(t2) * sin_dlon * sin_dlon;
    float c = 2.0f * atanf(sqrtf(a) / sqrtf(fmaxf(1.0f - a, 1e-6f)));
    return 6371.0f * c;
}

static void resolve_nodes(const log_parse_result_t *parsed) {
    g_state.node_count = 0;
    size_t ts_index = 0;
    uint64_t last_ts = 0;
    for (size_t i = 0; i < parsed->token_count && g_state.node_count < MAX_ROUTE_NODES; ++i) {
        if (!resolve_token_to_node(parsed->tokens[i], &g_state.nodes[g_state.node_count])) {
            continue;
        }
        route_node_t *node = &g_state.nodes[g_state.node_count++];
        if (ts_index < parsed->time_count) {
            node->timestamp = parsed->timestamps[ts_index++];
            last_ts = node->timestamp;
        } else {
            last_ts += 3600;
            node->timestamp = last_ts;
        }
    }
}

static void compute_edi(void) {
    g_state.total_distance = 0.0f;
    g_state.direct_distance = 0.0f;
    g_state.dwell_penalty = 0.0f;
    g_state.route_penalty = 0.0f;
    g_state.edi_score = 0.0f;
    if (g_state.node_count < 2) return;

    for (size_t i = 1; i < g_state.node_count; ++i) {
        const route_node_t *prev = &g_state.nodes[i - 1];
        const route_node_t *curr = &g_state.nodes[i];
        float leg = great_circle(prev->lat, prev->lon, curr->lat, curr->lon);
        g_state.total_distance += leg;
        if (strncmp(prev->iata, curr->iata, 3) == 0) {
            uint64_t delta = (curr->timestamp > prev->timestamp)
                                 ? (curr->timestamp - prev->timestamp)
                                 : 0;
            if (delta > DWELL_THRESHOLD_SECONDS) {
                float dwell = (float)delta / (float)DWELL_THRESHOLD_SECONDS;
                g_state.dwell_penalty += dwell;
            }
        }
    }

    g_state.direct_distance = great_circle(g_state.nodes[0].lat,
                                           g_state.nodes[0].lon,
                                           g_state.nodes[g_state.node_count - 1].lat,
                                           g_state.nodes[g_state.node_count - 1].lon);
    if (g_state.direct_distance < 1e-3f) return;

    float excess = g_state.total_distance - g_state.direct_distance;
    if (excess > 0.0f) {
        g_state.route_penalty = fminf(excess / (g_state.direct_distance * ROUTE_DEVIATION_DIVISOR), 1.0f);
    }

    float dwell_term = fminf(g_state.dwell_penalty, 1.0f);
    float deviation_term = fminf(g_state.route_penalty, 1.0f);
    float penalty = 0.65f * deviation_term + 0.35f * dwell_term;
    float score = 100.0f * (1.0f - penalty);
    if (score < 0.0f) score = 0.0f;
    if (score > 100.0f) score = 100.0f;
    g_state.edi_score = score;
}

bool logistics_analyze_tracking(const char *raw_json, logistics_tracking_result_t *out) {
    log_parse_result_t parsed;
    log_normalize(raw_json, &parsed);
    resolve_nodes(&parsed);
    compute_edi();

    if (out) {
        out->node_count = g_state.node_count;
        out->direct_km = g_state.direct_distance;
        out->traveled_km = g_state.total_distance;
        out->dwell_penalty = g_state.dwell_penalty;
        out->route_penalty = g_state.route_penalty;
        out->edi_score = g_state.edi_score;
    }

    return g_state.node_count > 0;
}

const char* logistics_analyze_tracking_json(const char *raw_json) {
    logistics_tracking_result_t result;
    logistics_analyze_tracking(raw_json, &result);

    int printed = snprintf(
        g_result_buffer,
        RESULT_BUFFER_SIZE,
        "{\"nodes\":%zu,\"directKm\":%.2f,\"traveledKm\":%.2f,\"dwellPenalty\":%.3f,"
        "\"routePenalty\":%.3f,\"idiotScore\":%.2f}",
        (size_t)result.node_count,
        result.direct_km,
        result.traveled_km,
        result.dwell_penalty,
        result.route_penalty,
        result.edi_score);
    if (printed < 0) g_result_buffer[0] = '\0';
    return g_result_buffer;
}

WASM_KEEPALIVE
const char* analyze_tracking(const char *raw_json) {
    return logistics_analyze_tracking_json(raw_json);
}

WASM_KEEPALIVE
float get_idiot_score(void) {
    return g_state.edi_score;
}
