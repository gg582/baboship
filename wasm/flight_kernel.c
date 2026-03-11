/*
 * flight_kernel.c — WebAssembly kernel for parcel location estimation.
 *
 * Processes raw aircraft flight-signal data, normalises it, generates
 * candidate transport routes between an origin and a destination, and
 * simulates probabilistic ETA distributions.
 *
 * Compile with Emscripten:
 *   emcc flight_kernel.c -std=c17 -O3 -Iinclude -D__EMSCRIPTEN__ \
 *        -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=\"createFlightKernel\" \
 *        -s ENVIRONMENT=web,worker -s ALLOW_MEMORY_GROWTH=1 \
 *        -s NO_EXIT_RUNTIME=1 \
 *        -s EXPORTED_FUNCTIONS='["_fk_init","_fk_load_signal_data","_fk_generate_candidates","_fk_compute_eta_distribution","_malloc","_free"]' \
 *        -s EXPORTED_RUNTIME_METHODS='["cwrap","UTF8ToString","stringToUTF8","lengthBytesUTF8","allocate","intArrayFromString","ALLOC_NORMAL"]' \
 *        -o ../docs/wasm/flight_kernel.js
 */

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define FK_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define FK_EXPORT
#endif

#include <ctype.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ---- constants ---- */
#define FK_MAX_AIRPORTS   32
#define FK_MAX_CANDIDATES 10
#define FK_JSON_BUF       8192

/* ---- internal types ---- */
typedef struct {
    char iata[4];
    double lat;
    double lon;
    char country[64];
} fk_airport_t;

typedef struct {
    char origin[4];
    char hubs[3][4]; /* up to 3 intermediate hubs */
    int  hub_count;
    char destination[4];
    double segment_hours[4]; /* one per leg */
    double transfer_hours[3]; /* transfer delay per hub */
    double plausibility_score; /* 0-100 */
} fk_candidate_t;

typedef struct {
    double lower_hours;
    double mode_hours;
    double upper_hours;
    double confidence; /* 0-1 */
    fk_candidate_t candidates[FK_MAX_CANDIDATES];
    int candidate_count;
} fk_eta_result_t;

/* ---- global state ---- */
static bool g_initialized = false;
static fk_airport_t g_airports[FK_MAX_AIRPORTS];
static int g_airport_count = 0;

/* ---- helpers ---- */
static double fk_deg2rad(double deg) { return deg * M_PI / 180.0; }

static double fk_gc_distance_km(double lat1, double lon1,
                                  double lat2, double lon2) {
    double r = 6371.0;
    double dlat = fk_deg2rad(lat2 - lat1);
    double dlon = fk_deg2rad(lon2 - lon1);
    double a = sin(dlat / 2.0) * sin(dlat / 2.0) +
               cos(fk_deg2rad(lat1)) * cos(fk_deg2rad(lat2)) *
               sin(dlon / 2.0) * sin(dlon / 2.0);
    double c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
    return r * c;
}

/* Rough flight-speed estimate in km/h (cargo wide-body cruises ~850 km/h) */
static double fk_flight_hours(double dist_km) {
    if (dist_km <= 0.0) return 0.5;
    /* add taxi/climb/descent time proportional to distance */
    double cruise = dist_km / 850.0;
    double fixed_overhead = 0.75; /* taxi + takeoff + approach/landing */
    return cruise + fixed_overhead;
}

/*
 * Normalise a signal-strength value (0-1) into a frequency weight.
 * Weak signals are penalised; strong signals get a moderate boost.
 */
static double fk_normalise_signal(double raw_signal) {
    if (raw_signal <= 0.0) return 0.0;
    if (raw_signal >= 1.0) return 1.0;
    /* S-curve normalisation */
    return 1.0 / (1.0 + exp(-10.0 * (raw_signal - 0.5)));
}

/* ---- simple airport database (seed data for when no signal loaded) ---- */
static const fk_airport_t FK_SEED_AIRPORTS[] = {
    {"ICN",  37.4691,  126.451, "Korea"},
    {"GMP",  37.5583,  126.794, "Korea"},
    {"NRT",  35.7647,  140.386, "Japan"},
    {"HND",  35.5494,  139.780, "Japan"},
    {"PVG",  31.1434,  121.805, "China"},
    {"HKG",  22.3089,  113.915, "Hong Kong"},
    {"SIN",   1.3502,  103.994, "Singapore"},
    {"BKK",  13.6811,  100.747, "Thailand"},
    {"DXB",  25.2528,   55.364, "UAE"},
    {"DOH",  25.2608,   51.565, "Qatar"},
    {"FRA",  50.0264,    8.543, "Germany"},
    {"AMS",  52.3086,    4.764, "Netherlands"},
    {"LHR",  51.4775,   -0.461, "UK"},
    {"CDG",  49.0097,    2.548, "France"},
    {"JFK",  40.6398,  -73.779, "USA"},
    {"ORD",  41.9742,  -87.907, "USA"},
    {"LAX",  33.9425, -118.408, "USA"},
    {"YYZ",  43.6772,  -79.631, "Canada"},
    {"SYD", -33.9461,  151.177, "Australia"},
    {"MEL", -37.6733,  144.843, "Australia"},
};
static const int FK_SEED_COUNT =
    (int)(sizeof(FK_SEED_AIRPORTS) / sizeof(FK_SEED_AIRPORTS[0]));

/* ---- exported API ---- */

/**
 * fk_init — initialise the kernel and seed the airport list.
 * Returns 1 on success.
 */
FK_EXPORT int fk_init(void) {
    if (g_initialized) return 1;
    int n = FK_SEED_COUNT < FK_MAX_AIRPORTS ? FK_SEED_COUNT : FK_MAX_AIRPORTS;
    for (int i = 0; i < n; i++) {
        g_airports[i] = FK_SEED_AIRPORTS[i];
    }
    g_airport_count = n;
    g_initialized = true;
    return 1;
}

/**
 * fk_load_signal_data — load flight-signal data from a JSON string.
 *
 * Expected format (array of objects):
 *   [{"iata":"ICN","lat":37.4,"lon":126.4,"country":"Korea","signal":0.9}, ...]
 *
 * Returns the number of airports that were loaded.
 */
FK_EXPORT int fk_load_signal_data(const char *json) {
    if (!json || !g_initialized) return 0;

    /* Simple JSON parser — find each "iata" key and parse sibling fields. */
    int loaded = 0;
    const char *p = json;
    while (*p && loaded < FK_MAX_AIRPORTS) {
        /* Look for "iata": */
        const char *iata_key = strstr(p, "\"iata\"");
        if (!iata_key) break;
        const char *colon = strchr(iata_key + 6, ':');
        if (!colon) break;
        const char *q = colon + 1;
        while (*q == ' ' || *q == '"') q++;
        if (!*q) break;

        fk_airport_t ap;
        memset(&ap, 0, sizeof(ap));
        int ci = 0;
        while (*q && *q != '"' && *q != ',' && *q != '}' && ci < 3) {
            ap.iata[ci++] = (char)toupper((unsigned char)*q);
            q++;
        }
        ap.iata[3] = '\0';

        /* lat */
        const char *lat_key = strstr(iata_key, "\"lat\"");
        if (lat_key) {
            const char *lc = strchr(lat_key + 5, ':');
            if (lc) ap.lat = strtod(lc + 1, NULL);
        }
        /* lon */
        const char *lon_key = strstr(iata_key, "\"lon\"");
        if (lon_key) {
            const char *lc = strchr(lon_key + 5, ':');
            if (lc) ap.lon = strtod(lc + 1, NULL);
        }
        /* country */
        const char *cnt_key = strstr(iata_key, "\"country\"");
        if (cnt_key) {
            const char *cc = strchr(cnt_key + 9, ':');
            if (cc) {
                while (*cc == ':' || *cc == ' ' || *cc == '"') cc++;
                int k = 0;
                while (*cc && *cc != '"' && k < 63) {
                    ap.country[k++] = *cc++;
                }
                ap.country[k] = '\0';
            }
        }
        /* signal — normalise and store as a frequency weight.
         * A stronger signal means the airport is more likely to be active
         * on the requested route; we encode it by scaling the record's
         * presence (entries with weight < 0.1 are skipped).          */
        const char *sig_key = strstr(iata_key, "\"signal\"");
        double signal_weight = 1.0;
        if (sig_key) {
            const char *sc = strchr(sig_key + 8, ':');
            if (sc) signal_weight = fk_normalise_signal(strtod(sc + 1, NULL));
        }
        if (signal_weight < 0.1) { p = q; continue; } /* skip low-signal entries */

        /* Overwrite existing entry or append */
        bool found = false;
        for (int i = 0; i < g_airport_count; i++) {
            if (strncmp(g_airports[i].iata, ap.iata, 3) == 0) {
                g_airports[i] = ap;
                found = true;
                break;
            }
        }
        if (!found && g_airport_count < FK_MAX_AIRPORTS) {
            g_airports[g_airport_count++] = ap;
        }
        loaded++;
        p = q;
    }
    return loaded;
}

/* Lookup airport by IATA code; returns NULL if not found.
 * IATA codes are always stored as uppercase, so strncmp is sufficient. */
static const fk_airport_t *fk_find_airport(const char *iata) {
    for (int i = 0; i < g_airport_count; i++) {
        if (strncmp(g_airports[i].iata, iata, 3) == 0) {
            return &g_airports[i];
        }
    }
    return NULL;
}

/*
 * Score a candidate route using heuristics:
 *  - geographic consistency (great-circle alignment)
 *  - total flight time (shorter is better)
 *  - transfer count (fewer is better)
 *  Returns a value in [0, 100].
 */
static double fk_score_candidate(const fk_candidate_t *c,
                                   double origin_lat,  double origin_lon,
                                   double dest_lat,    double dest_lon) {
    double direct_dist = fk_gc_distance_km(origin_lat, origin_lon,
                                            dest_lat,   dest_lon);
    /* sum of all segment distances */
    double prev_lat = origin_lat, prev_lon = origin_lon;
    double total_dist = 0.0;
    for (int h = 0; h < c->hub_count; h++) {
        const fk_airport_t *hub = fk_find_airport(c->hubs[h]);
        if (!hub) continue;
        total_dist += fk_gc_distance_km(prev_lat, prev_lon, hub->lat, hub->lon);
        prev_lat = hub->lat;
        prev_lon = hub->lon;
    }
    total_dist += fk_gc_distance_km(prev_lat, prev_lon, dest_lat, dest_lon);

    /* geographic consistency: ratio of direct to actual (1 = perfect) */
    double geo_score = (total_dist > 0.0)
                       ? fmin(1.0, direct_dist / total_dist)
                       : 1.0;

    /* time score: prefer routes under 48 h */
    double total_hours = 0.0;
    for (int i = 0; i < c->hub_count + 1 && i < 4; i++) {
        total_hours += c->segment_hours[i];
    }
    for (int i = 0; i < c->hub_count && i < 3; i++) {
        total_hours += c->transfer_hours[i];
    }
    double time_score = fmax(0.0, 1.0 - (total_hours - 12.0) / 72.0);

    /* transfer penalty */
    double transfer_penalty = 1.0 - 0.05 * c->hub_count;
    if (transfer_penalty < 0.5) transfer_penalty = 0.5;

    return 100.0 * geo_score * time_score * transfer_penalty;
}

/**
 * fk_generate_candidates — generate up to FK_MAX_CANDIDATES route candidates
 * between origin and destination airports.
 *
 * Returns a JSON array string with the candidate routes.
 */
FK_EXPORT const char *fk_generate_candidates(const char *origin_iata,
                                               const char *dest_iata) {
    static char buf[FK_JSON_BUF];

    if (!g_initialized || !origin_iata || !dest_iata) {
        snprintf(buf, sizeof(buf), "[]");
        return buf;
    }

    const fk_airport_t *orig = fk_find_airport(origin_iata);
    const fk_airport_t *dest = fk_find_airport(dest_iata);
    if (!orig || !dest) {
        snprintf(buf, sizeof(buf), "[]");
        return buf;
    }

    fk_candidate_t candidates[FK_MAX_CANDIDATES];
    int count = 0;

    /* Candidate 0: direct route (no hubs) */
    {
        fk_candidate_t c;
        memset(&c, 0, sizeof(c));
        strncpy(c.origin, orig->iata, 3);
        strncpy(c.destination, dest->iata, 3);
        c.hub_count = 0;
        double dist = fk_gc_distance_km(orig->lat, orig->lon, dest->lat, dest->lon);
        c.segment_hours[0] = fk_flight_hours(dist);
        c.plausibility_score = fk_score_candidate(&c, orig->lat, orig->lon,
                                                    dest->lat, dest->lon);
        candidates[count++] = c;
    }

    /* Candidates 1-N: via each hub airport that lies geographically between */
    for (int h = 0; h < g_airport_count && count < FK_MAX_CANDIDATES; h++) {
        const fk_airport_t *hub = &g_airports[h];
        if (strncmp(hub->iata, orig->iata, 3) == 0) continue;
        if (strncmp(hub->iata, dest->iata, 3) == 0) continue;

        /* Only use hubs that lie geographically between origin and dest */
        double orig_hub = fk_gc_distance_km(orig->lat, orig->lon, hub->lat, hub->lon);
        double hub_dest = fk_gc_distance_km(hub->lat, hub->lon, dest->lat, dest->lon);
        double orig_dest = fk_gc_distance_km(orig->lat, orig->lon, dest->lat, dest->lon);
        /* prune hubs that add more than 35 % detour */
        if (orig_hub + hub_dest > orig_dest * 1.35) continue;

        fk_candidate_t c;
        memset(&c, 0, sizeof(c));
        strncpy(c.origin, orig->iata, 3);
        strncpy(c.hubs[0], hub->iata, 3);
        c.hub_count = 1;
        strncpy(c.destination, dest->iata, 3);
        c.segment_hours[0] = fk_flight_hours(orig_hub);
        c.transfer_hours[0] = 2.5; /* typical cargo transfer window */
        c.segment_hours[1] = fk_flight_hours(hub_dest);
        c.plausibility_score = fk_score_candidate(&c, orig->lat, orig->lon,
                                                    dest->lat, dest->lon);
        candidates[count++] = c;
    }

    /* Sort by plausibility descending (simple insertion sort on small array) */
    for (int i = 1; i < count; i++) {
        fk_candidate_t key = candidates[i];
        int j = i - 1;
        while (j >= 0 && candidates[j].plausibility_score < key.plausibility_score) {
            candidates[j + 1] = candidates[j];
            j--;
        }
        candidates[j + 1] = key;
    }
    if (count > FK_MAX_CANDIDATES) count = FK_MAX_CANDIDATES;

    /* Serialise to JSON — guard against buffer overflow at each step */
    int pos = 0;
#define FK_APPEND(...) do { \
        if ((size_t)pos < sizeof(buf) - 1) { \
            int _n = snprintf(buf + pos, sizeof(buf) - (size_t)pos, __VA_ARGS__); \
            if (_n > 0) pos += _n; \
            if ((size_t)pos >= sizeof(buf)) pos = (int)(sizeof(buf) - 1); \
        } \
    } while (0)

    FK_APPEND("[");
    for (int i = 0; i < count; i++) {
        if ((size_t)pos + 256 >= sizeof(buf)) break; /* safety margin */
        const fk_candidate_t *c = &candidates[i];
        if (i > 0) FK_APPEND(",");
        FK_APPEND(
            "{\"origin\":\"%s\",\"destination\":\"%s\","
            "\"hubCount\":%d,",
            c->origin, c->destination, c->hub_count);
        FK_APPEND("\"hubs\":[");
        for (int h = 0; h < c->hub_count; h++) {
            if (h > 0) FK_APPEND(",");
            FK_APPEND("\"%s\"", c->hubs[h]);
        }
        FK_APPEND("],");

        double total_hours = 0.0;
        for (int s = 0; s <= c->hub_count && s < 4; s++) {
            total_hours += c->segment_hours[s];
        }
        for (int t = 0; t < c->hub_count && t < 3; t++) {
            total_hours += c->transfer_hours[t];
        }
        FK_APPEND(
            "\"totalFlightHours\":%.2f,"
            "\"plausibilityScore\":%.2f}",
            total_hours, c->plausibility_score);
    }
    FK_APPEND("]");
#undef FK_APPEND
    return buf;
}

/*
 * Probabilistic delay model.
 * All values in hours.
 */
typedef struct {
    double origin_handling_min;
    double origin_handling_max;
    double departure_wait_min;
    double departure_wait_max;
    double customs_min;
    double customs_max;
    double last_mile_min;
    double last_mile_max;
} fk_delay_model_t;

static const fk_delay_model_t FK_DELAY = {
    .origin_handling_min  =  2.0,
    .origin_handling_max  = 12.0,
    .departure_wait_min   =  1.0,
    .departure_wait_max   =  6.0,
    .customs_min          =  2.0,
    .customs_max          = 24.0,
    .last_mile_min        =  4.0,
    .last_mile_max        = 48.0,
};

/**
 * fk_compute_eta_distribution — given a JSON candidates array (as returned by
 * fk_generate_candidates), compute a probabilistic ETA distribution.
 *
 * Returns a JSON object with lower/mode/upper bounds (in hours from dispatch)
 * plus per-candidate scores.
 */
FK_EXPORT const char *fk_compute_eta_distribution(const char *candidates_json) {
    static char buf[FK_JSON_BUF];

    if (!g_initialized || !candidates_json) {
        snprintf(buf, sizeof(buf),
            "{\"lowerHours\":24,\"modeHours\":72,\"upperHours\":168,"
            "\"confidence\":0.3,\"candidates\":[]}");
        return buf;
    }

    /* Parse total_flight_hours and plausibility from each candidate */
    double weighted_sum = 0.0;
    double weight_total = 0.0;
    double min_hours = 1e9, max_hours = 0.0;
    int cand_count = 0;
    double cand_hours[FK_MAX_CANDIDATES];
    double cand_scores[FK_MAX_CANDIDATES];

    const char *p = candidates_json;
    while (*p && cand_count < FK_MAX_CANDIDATES) {
        const char *fh = strstr(p, "\"totalFlightHours\":");
        if (!fh) break;
        double fhours = strtod(fh + 19, NULL);

        const char *ps = strstr(p, "\"plausibilityScore\":");
        double score = ps ? strtod(ps + 20, NULL) : 50.0;

        /* Add delay model */
        double delay_mode =
            (FK_DELAY.origin_handling_min + FK_DELAY.origin_handling_max) / 2.0 +
            (FK_DELAY.departure_wait_min  + FK_DELAY.departure_wait_max)  / 2.0 +
            (FK_DELAY.customs_min         + FK_DELAY.customs_max)         / 2.0 +
            (FK_DELAY.last_mile_min       + FK_DELAY.last_mile_max)       / 2.0;

        double total_mode = fhours + delay_mode;
        double weight = score / 100.0;

        weighted_sum  += total_mode * weight;
        weight_total  += weight;
        if (total_mode < min_hours) min_hours = total_mode;
        if (total_mode > max_hours) max_hours = total_mode;

        cand_hours[cand_count] = total_mode;
        cand_scores[cand_count] = score;
        cand_count++;
        p = ps ? ps + 20 : fh + 19;
    }

    if (cand_count == 0 || weight_total <= 0.0) {
        snprintf(buf, sizeof(buf),
            "{\"lowerHours\":24,\"modeHours\":72,\"upperHours\":168,"
            "\"confidence\":0.2,\"candidates\":[]}");
        return buf;
    }

    double mode_hours  = weighted_sum / weight_total;
    double lower_hours = min_hours +
        (FK_DELAY.origin_handling_min + FK_DELAY.departure_wait_min +
         FK_DELAY.customs_min + FK_DELAY.last_mile_min) -
        (FK_DELAY.origin_handling_max + FK_DELAY.departure_wait_max +
         FK_DELAY.customs_max + FK_DELAY.last_mile_max) / 4.0;
    if (lower_hours < 12.0) lower_hours = 12.0;

    double upper_hours = max_hours +
        (FK_DELAY.origin_handling_max + FK_DELAY.departure_wait_max +
         FK_DELAY.customs_max + FK_DELAY.last_mile_max);

    double range = upper_hours - lower_hours;
    double confidence = (range > 0.0)
        ? fmin(1.0, 1.0 - (range - 24.0) / (upper_hours + 1.0))
        : 0.5;
    if (confidence < 0.1) confidence = 0.1;

    int pos = 0;
#define FK_ETA_APPEND(...) do { \
        if ((size_t)pos < sizeof(buf) - 1) { \
            int _n = snprintf(buf + pos, sizeof(buf) - (size_t)pos, __VA_ARGS__); \
            if (_n > 0) pos += _n; \
            if ((size_t)pos >= sizeof(buf)) pos = (int)(sizeof(buf) - 1); \
        } \
    } while (0)

    FK_ETA_APPEND(
        "{\"lowerHours\":%.1f,\"modeHours\":%.1f,\"upperHours\":%.1f,"
        "\"confidence\":%.3f,\"candidates\":[",
        lower_hours, mode_hours, upper_hours, confidence);

    for (int i = 0; i < cand_count; i++) {
        FK_ETA_APPEND(i > 0 ? ",{\"totalHours\":%.1f,\"score\":%.1f}"
                             :  "{\"totalHours\":%.1f,\"score\":%.1f}",
            cand_hours[i], cand_scores[i]);
    }
    FK_ETA_APPEND("]}");
#undef FK_ETA_APPEND
    return buf;
}
