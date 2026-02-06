#include <ctype.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

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

// nuke_calc: High-performance calculation for a single route leg
// Takes lat1, lon1, lat2, lon2 and returns pre-processed logistics score
WASM_KEEPALIVE
double nuke_wasm_calc_score(double lat1, double lon1, double lat2, double lon2, double reliability) {
    double dist = great_circle_distance(lat1, lon1, lat2, lon2);
    if (dist <= 0) return 0;
    
    // Logic: score = (reliability / distance) * 1000
    // Higher is better (more reliable per unit distance)
    return (reliability / (dist + 1.0)) * 1000.0;
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

typedef struct {
    const char *continent_code;
    const char *continent_label;
    const char *country;
    const char *iso_code;
    const char *anchor_airport;
    double avg_hours;
    double reliability;
    const char *notes;
} logistics_best_node_t;

static const logistics_best_node_t BEST_NODES[] = {
    {"AS", "아시아", "대한민국", "KR", "ICN", 16.2, 98.1, "24시간 통관과 저온 물류 창고를 동시에 운영"},
    {"EU", "유럽", "독일", "DE", "FRA", 15.7, 97.4, "프랑크푸르트 기반의 안정적인 인프라"},
    {"NA", "북아메리카", "미국", "US", "CVG", 14.3, 96.9, "동서부를 동시에 커버하는 대형 허브"},
    {"SA", "남아메리카", "칠레", "CL", "SCL", 18.5, 94.1, "안정적인 냉장 전력과 태평양 루트"},
    {"AF", "아프리카", "모로코", "MA", "CMN", 17.6, 92.3, "대서양 관문과 유럽 연계성이 우수"},
    {"OC", "오세아니아", "호주", "AU", "SYD", 19.2, 93.8, "복합 운송이 쉬운 시드니 권역"}
};

WASM_KEEPALIVE
const char* nuke_wasm_get_best_nodes_json(void) {
    static char buffer[4096];
    size_t offset = 0;
    offset += snprintf(buffer + offset, sizeof(buffer) - offset, "{\"items\":[");
    for (size_t i = 0; i < sizeof(BEST_NODES) / sizeof(BEST_NODES[0]); ++i) {
        offset += snprintf(buffer + offset, sizeof(buffer) - offset,
            "%s{\"continentCode\":\"%s\",\"continentLabel\":\"%s\",\"country\":\"%s\",\"isoCode\":\"%s\",\"anchorAirport\":\"%s\",\"avgHours\":%.1f,\"reliability\":%.1f,\"notes\":\"%s\"}",
            (i == 0 ? "" : ","),
            BEST_NODES[i].continent_code,
            BEST_NODES[i].continent_label,
            BEST_NODES[i].country,
            BEST_NODES[i].iso_code,
            BEST_NODES[i].anchor_airport,
            BEST_NODES[i].avg_hours,
            BEST_NODES[i].reliability,
            BEST_NODES[i].notes
        );
    }
    snprintf(buffer + offset, sizeof(buffer) - offset, "]}");
    return buffer;
}

WASM_KEEPALIVE
const char* nuke_wasm_get_airports_json(void) {
    static char buffer[2048];
    // Simple static list of coordinates for the best nodes
    // ICN: 37.46, 126.44 | FRA: 50.03, 8.57 | CVG: 39.04, -84.66
    // SCL: -33.39, -70.78 | CMN: 33.36, -7.58 | SYD: -33.94, 151.17
    const char *json = "{\"total\":6,\"offset\":0,\"returned\":6,\"airports\":["
        "{\"id\":1,\"code\":\"ICN\",\"lat\":37.46,\"lon\":126.44},"
        "{\"id\":2,\"code\":\"FRA\",\"lat\":50.03,\"lon\":8.57},"
        "{\"id\":3,\"code\":\"CVG\",\"lat\":39.04,\"lon\":-84.66},"
        "{\"id\":4,\"code\":\"SCL\",\"lat\":-33.39,\"lon\":-70.78},"
        "{\"id\":5,\"code\":\"CMN\",\"lat\":33.36,\"lon\":-7.58},"
        "{\"id\":6,\"code\":\"SYD\",\"lat\":-33.94,\"lon\":151.17}"
    "]}";
    snprintf(buffer, sizeof(buffer), "%s", json);
    return buffer;
}

WASM_KEEPALIVE
const char* nuke_wasm_get_health_json(void) {
    static char buffer[256];
    const char *json = "{\"airports_loaded\":6,\"routes_loaded\":15,\"nuke_online\":true,\"worker_threads\":0}";
    snprintf(buffer, sizeof(buffer), "%s", json);
    return buffer;
}

WASM_KEEPALIVE
const char* nuke_wasm_search_routes_json(const char *from, const char *to) {
    static char buffer[2048];
    // Return a mocked direct route if codes are valid, else empty
    if (!from || !to || strlen(from) != 3 || strlen(to) != 3) {
        snprintf(buffer, sizeof(buffer), "{\"from\":\"%s\",\"to\":\"%s\",\"results\":0,\"paths\":[]}", 
                 from ? from : "???", to ? to : "???");
        return buffer;
    }

    // Just a placeholder "Serverless" result
    const char *json_fmt = "{\"from\":\"%s\",\"to\":\"%s\",\"results\":1,\"paths\":["
        "{\"hops\":0,\"legs\":1,\"totalDistanceKm\":1234.5,\"greatCircleKm\":1234.5,\"efficiency\":1.0,"
        "\"airports\":[{\"id\":1,\"code\":\"%s\"},{\"id\":2,\"code\":\"%s\"}]}"
    "]}";
    snprintf(buffer, sizeof(buffer), json_fmt, from, to, from, to);
    return buffer;
}
