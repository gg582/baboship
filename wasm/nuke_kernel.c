#include <ctype.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define WASM_KEEPALIVE EMSCRIPTEN_KEEPALIVE
#else
#define WASM_KEEPALIVE
#endif

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define EARTH_RADIUS_KM 6371.0

static double degrees_to_radians(double degrees) {
    return degrees * (M_PI / 180.0);
}

static double clamp_lat(double lat) {
    if (lat > 90.0) return 90.0;
    if (lat < -90.0) return -90.0;
    return lat;
}

static double normalize_lon(double lon) {
    while (lon > 180.0) {
        lon -= 360.0;
    }
    while (lon < -180.0) {
        lon += 360.0;
    }
    return lon;
}

static double great_circle_distance(double lat1, double lon1, double lat2, double lon2) {
    lat1 = clamp_lat(lat1);
    lat2 = clamp_lat(lat2);
    lon1 = normalize_lon(lon1);
    lon2 = normalize_lon(lon2);

    const double dlat = degrees_to_radians(lat2 - lat1);
    const double dlon = degrees_to_radians(lon2 - lon1);
    const double rad_lat1 = degrees_to_radians(lat1);
    const double rad_lat2 = degrees_to_radians(lat2);

    const double a = sin(dlat / 2.0) * sin(dlat / 2.0) +
                     sin(dlon / 2.0) * sin(dlon / 2.0) * cos(rad_lat1) * cos(rad_lat2);
    const double c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
    return EARTH_RADIUS_KM * c;
}

WASM_KEEPALIVE
double nuke_wasm_gc_distance(double lat1, double lon1, double lat2, double lon2) {
    return great_circle_distance(lat1, lon1, lat2, lon2);
}

WASM_KEEPALIVE
double nuke_wasm_route_distance(const double *coords, size_t point_count) {
    if (!coords || point_count < 2) {
        return 0.0;
    }
    double total = 0.0;
    for (size_t i = 1; i < point_count; ++i) {
        const size_t prev_idx = (i - 1) * 2;
        const size_t curr_idx = i * 2;
        const double lat1 = coords[prev_idx];
        const double lon1 = coords[prev_idx + 1];
        const double lat2 = coords[curr_idx];
        const double lon2 = coords[curr_idx + 1];
        total += great_circle_distance(lat1, lon1, lat2, lon2);
    }
    return total;
}

WASM_KEEPALIVE
double nuke_wasm_efficiency(double gc_distance_km, double actual_distance_km) {
    if (gc_distance_km <= 0.0 || actual_distance_km <= 0.0) {
        return 0.0;
    }
    const double ratio = gc_distance_km / actual_distance_km;
    return ratio * 100.0;
}

WASM_KEEPALIVE
int nuke_wasm_is_valid_iata(const char *code) {
    if (!code) return 0;
    for (size_t i = 0; i < 3; ++i) {
        const unsigned char ch = (unsigned char)code[i];
        if (!isalpha(ch)) {
            return 0;
        }
        if (ch == '\0') {
            return 0;
        }
    }
    return code[3] == '\0';
}
