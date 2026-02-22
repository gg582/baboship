#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <math.h>
#include <stdbool.h>
#include <ctype.h>
#include <string.h>
#include <strings.h>
#include <sys/types.h>
#include <stdint.h>

#include <cwist/sys/app/app.h>
#include <cwist/core/sstring/sstring.h>
#include <cwist/core/db/nuke_db.h>
#include <cwist/core/db/sql.h>
#include <cwist/core/template/template.h>
#include <cjson/cJSON.h>
#include <sqlite3.h>

#include "nuke_flight.h"
#include "logistics_engine.h"

typedef struct {
    nuke_flight_store_t store;
    sqlite3 *nuke_conn;
    cwist_db *meta_db;
} nuke_server_state_t;

typedef struct {
    char continent_code[4];
    char continent_label[32];
    char country[48];
    char iso_code[4];
    char anchor_node[4]; // Renamed from anchor_airport
    double avg_hours;
    double reliability;
    char notes[128];
    char layer[NUKE_LAYER_MAX_LEN]; // New: layer of the best node
} logistics_best_node_t;

typedef struct {
    char origin[4];
    char destination[4];
    char reason[160];
} logistics_block_rule_t;

static char *dup_string(const char *src) {
    if (!src) return NULL;
    size_t len = strlen(src) + 1;
    char *copy = malloc(len);
    if (copy) memcpy(copy, src, len);
    return copy;
}

static nuke_server_state_t g_state = {0};
static cwist_app *g_app = NULL;
static bool g_cleaned = false;
static logistics_best_node_t *g_best_nodes = NULL;
static size_t g_best_node_count = 0;
static logistics_block_rule_t *g_block_rules = NULL;
static size_t g_block_rule_count = 0;

const nuke_flight_store_t* logistics_native_get_store(void) {
    return &g_state.store;
}

static void cleanup(void) {
    if (g_cleaned) return;
    g_cleaned = true;
    nuke_flight_store_destroy(&g_state.store);
    free(g_best_nodes);
    g_best_nodes = NULL;
    g_best_node_count = 0;
    free(g_block_rules);
    g_block_rules = NULL;
    g_block_rule_count = 0;
    if (g_state.meta_db) {
        cwist_db_close(g_state.meta_db);
        g_state.meta_db = NULL;
    }
    cwist_nuke_close();
    if (g_app) {
        cwist_app_destroy(g_app);
        g_app = NULL;
    }
}

static void handle_sigint(int signum) {
    (void)signum;
    cleanup();
    exit(0);
}

static void write_json_response(cwist_http_response *res, cJSON *json, cwist_http_status_t status) {
    char *payload = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!payload) {
        cwist_http_header_add(&res->headers, "Content-Type", "application/json");
        cwist_sstring_assign(res->body, (char *)"{\"error\":\"serialization failed\"}");
        res->status_code = CWIST_HTTP_INTERNAL_ERROR;
        return;
    }
    cwist_http_header_add(&res->headers, "Content-Type", "application/json");
    cwist_sstring_assign(res->body, payload);
    res->status_code = status;
    cJSON_free(payload);
}

static bool ensure_best_nodes_seed_locked(sqlite3 *conn) {
    const char *ddl =
        "CREATE TABLE IF NOT EXISTS logistics_best_nodes ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "continent_code TEXT NOT NULL,"
        "continent_label TEXT NOT NULL,"
        "country TEXT NOT NULL,"
        "iso_code TEXT NOT NULL,"
        "anchor_node TEXT NOT NULL," // Renamed from anchor_airport
        "avg_hours REAL NOT NULL,"
        "reliability REAL NOT NULL,"
        "notes TEXT NOT NULL,"
        "layer TEXT NOT NULL" // New: layer of the best node
        ");";
    if (sqlite3_exec(conn, ddl, NULL, NULL, NULL) != SQLITE_OK) {
        return false;
    }
    sqlite3_stmt *stmt = NULL;
    size_t row_count = 0;
    if (sqlite3_prepare_v2(conn, "SELECT COUNT(*) FROM logistics_best_nodes;", -1, &stmt, NULL) != SQLITE_OK) {
        return false;
    }
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        row_count = (size_t)sqlite3_column_int64(stmt, 0);
    }
    sqlite3_finalize(stmt);
    if (row_count > 0) return true;
    typedef struct {
        const char *code;
        const char *label;
        const char *country;
        const char *iso;
        const char *node; // Renamed from airport
        double avg_hours;
        double reliability;
        const char *notes;
        const char *layer; // New: layer of the best node
    } default_best_t;
    static const default_best_t defaults[] = {
        {"AS", "아시아", "대한민국", "KR", "ICN", 16.2, 98.1, "24시간 통관과 저온 물류 창고를 동시에 운영", "air"},
        {"EU", "유럽", "독일", "DE", "FRA", 15.7, 97.4, "프랑크푸르트 기반의 안정적인 인프라", "air"},
        {"ME", "중동", "아랍에미리트", "AE", "DXB", 17.8, 96.5, "글로벌 환적 허브와 24시간 운영 체계", "air"},
        {"NA", "북아메리카", "미국", "US", "CVG", 14.3, 96.9, "동서부를 동시에 커버하는 대형 허브", "air"},
        {"SA", "남아메리카", "칠레", "CL", "SCL", 18.5, 94.1, "안정적인 냉장 전력과 태평양 루트", "air"},
        {"AF", "아프리카", "모로코", "MA", "CMN", 17.6, 92.3, "대서양 관문과 유럽 연계성이 우수", "air"},
        {"OC", "오세아니아", "호주", "AU", "SYD", 19.2, 93.8, "복합 운송이 쉬운 시드니 권역", "air"},
        {"AS", "아시아", "싱가포르", "SG", "SGSIN", 20.0, 95.0, "동남아시아 해상 물류 허브", "sea"} // Example sea node
    };
    if (sqlite3_prepare_v2(conn,
                           "INSERT INTO logistics_best_nodes "
                           "(continent_code, continent_label, country, iso_code, anchor_node, avg_hours, reliability, notes, layer) " // Renamed anchor_airport, added layer
                           "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);", // Added one '?' for layer
                           -1,
                           &stmt,
                           NULL) != SQLITE_OK) {
        return false;
    }
    for (size_t i = 0; i < sizeof(defaults) / sizeof(defaults[0]); ++i) {
        sqlite3_bind_text(stmt, 1, defaults[i].code, -1, SQLITE_STATIC);
        sqlite3_bind_text(stmt, 2, defaults[i].label, -1, SQLITE_STATIC);
        sqlite3_bind_text(stmt, 3, defaults[i].country, -1, SQLITE_STATIC);
        sqlite3_bind_text(stmt, 4, defaults[i].iso, -1, SQLITE_STATIC);

        sqlite3_bind_text(stmt, 5, defaults[i].node, -1, SQLITE_STATIC); // Renamed anchor_airport
        sqlite3_bind_double(stmt, 6, defaults[i].avg_hours);
        sqlite3_bind_double(stmt, 7, defaults[i].reliability);
        sqlite3_bind_text(stmt, 8, defaults[i].notes, -1, SQLITE_STATIC);
        sqlite3_bind_text(stmt, 9, defaults[i].layer, -1, SQLITE_STATIC); // New: bind layer
        if (sqlite3_step(stmt) != SQLITE_DONE) {
            sqlite3_finalize(stmt);
            return false;
        }
        sqlite3_reset(stmt);
    }
    sqlite3_finalize(stmt);
    return true;
}

static bool ensure_restrictions_seed_locked(sqlite3 *conn) {
    const char *ddl =
        "CREATE TABLE IF NOT EXISTS logistics_restrictions ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "origin TEXT NOT NULL,"
        "destination TEXT NOT NULL,"
        "reason TEXT NOT NULL"
        ");";
    if (sqlite3_exec(conn, ddl, NULL, NULL, NULL) != SQLITE_OK) {
        return false;
    }
    sqlite3_stmt *stmt = NULL;
    size_t row_count = 0;
    if (sqlite3_prepare_v2(conn, "SELECT COUNT(*) FROM logistics_restrictions;", -1, &stmt, NULL) != SQLITE_OK) {
        return false;
    }
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        row_count = (size_t)sqlite3_column_int64(stmt, 0);
    }
    sqlite3_finalize(stmt);
    if (row_count == 0) {
        free(g_block_rules);
        g_block_rules = NULL;
        g_block_rule_count = 0;
        return true;
    }
    logistics_block_rule_t *buffer = calloc(row_count, sizeof(*buffer));
    if (!buffer) {
        return false;
    }
    if (sqlite3_prepare_v2(conn,
                           "SELECT origin, destination, reason FROM logistics_restrictions;",
                           -1,
                           &stmt,
                           NULL) != SQLITE_OK) {
        free(buffer);
        return false;
    }
    size_t idx = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW && idx < row_count) {
        const unsigned char *origin = sqlite3_column_text(stmt, 0);
        const unsigned char *destination = sqlite3_column_text(stmt, 1);
        const unsigned char *reason = sqlite3_column_text(stmt, 2);
        snprintf(buffer[idx].origin, sizeof(buffer[idx].origin), "%s", origin ? (const char *)origin : "");
        snprintf(buffer[idx].destination, sizeof(buffer[idx].destination), "%s", destination ? (const char *)destination : "");
        snprintf(buffer[idx].reason, sizeof(buffer[idx].reason), "%s", reason ? (const char *)reason : "");
        idx++;
    }
    sqlite3_finalize(stmt);
    free(g_block_rules);
    g_block_rules = buffer;
    g_block_rule_count = idx;
    return true;
}

static bool load_best_nodes_locked(sqlite3 *conn) {
    sqlite3_stmt *stmt = NULL;
    size_t row_count = 0;
    if (sqlite3_prepare_v2(conn, "SELECT COUNT(*) FROM logistics_best_nodes;", -1, &stmt, NULL) != SQLITE_OK) {
        return false;
    }
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        row_count = (size_t)sqlite3_column_int64(stmt, 0);
    }
    sqlite3_finalize(stmt);
    if (row_count == 0) {
        free(g_best_nodes);
        g_best_nodes = NULL;
        g_best_node_count = 0;
        return false;
    }
    logistics_best_node_t *buffer = calloc(row_count, sizeof(*buffer));
    if (!buffer) {
        return false;
    }
    if (sqlite3_prepare_v2(conn,
                           "SELECT continent_code, continent_label, country, iso_code, anchor_node, " // Renamed anchor_airport
                           "avg_hours, reliability, notes, layer " // Added layer
                           "FROM logistics_best_nodes ORDER BY continent_code;",
                           -1,
                           &stmt,
                           NULL) != SQLITE_OK) {
        free(buffer);
        return false;
    }
    size_t idx = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW && idx < row_count) {
        const unsigned char *continent_code = sqlite3_column_text(stmt, 0);
        const unsigned char *continent_label = sqlite3_column_text(stmt, 1);
        const unsigned char *country = sqlite3_column_text(stmt, 2);
        const unsigned char *iso_code = sqlite3_column_text(stmt, 3);
        const unsigned char *anchor_node = sqlite3_column_text(stmt, 4); // Renamed anchor_airport
        const unsigned char *notes = sqlite3_column_text(stmt, 7);
        const unsigned char *layer = sqlite3_column_text(stmt, 8); // New: layer
        snprintf(buffer[idx].continent_code, sizeof(buffer[idx].continent_code), "%s", continent_code ? (const char *)continent_code : "");
        snprintf(buffer[idx].continent_label, sizeof(buffer[idx].continent_label), "%s", continent_label ? (const char *)continent_label : "");
        snprintf(buffer[idx].country, sizeof(buffer[idx].country), "%s", country ? (const char *)country : "");
        snprintf(buffer[idx].iso_code, sizeof(buffer[idx].iso_code), "%s", iso_code ? (const char *)iso_code : "");
        snprintf(buffer[idx].anchor_node, sizeof(buffer[idx].anchor_node), "%s", anchor_node ? (const char *)anchor_node : ""); // Renamed anchor_airport
        buffer[idx].avg_hours = sqlite3_column_double(stmt, 5);
        buffer[idx].reliability = sqlite3_column_double(stmt, 6);
        snprintf(buffer[idx].notes, sizeof(buffer[idx].notes), "%s", notes ? (const char *)notes : "");
        snprintf(buffer[idx].layer, sizeof(buffer[idx].layer), "%s", layer ? (const char *)layer : ""); // New: layer
        idx++;
    }
    sqlite3_finalize(stmt);
    free(g_best_nodes);
    g_best_nodes = buffer;
    g_best_node_count = idx;
    return idx > 0;
}

static bool load_restrictions_locked(sqlite3 *conn) {
    sqlite3_stmt *stmt = NULL;
    size_t row_count = 0;
    if (sqlite3_prepare_v2(conn, "SELECT COUNT(*) FROM logistics_restrictions;", -1, &stmt, NULL) != SQLITE_OK) {
        return false;
    }
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        row_count = (size_t)sqlite3_column_int64(stmt, 0);
    }
    sqlite3_finalize(stmt);
    if (row_count == 0) {
        free(g_block_rules);
        g_block_rules = NULL;
        g_block_rule_count = 0;
        return true;
    }
    logistics_block_rule_t *buffer = calloc(row_count, sizeof(*buffer));
    if (!buffer) {
        return false;
    }
    if (sqlite3_prepare_v2(conn,
                           "SELECT origin, destination, reason FROM logistics_restrictions;",
                           -1,
                           &stmt,
                           NULL) != SQLITE_OK) {
        free(buffer);
        return false;
    }
    size_t idx = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW && idx < row_count) {
        const unsigned char *origin = sqlite3_column_text(stmt, 0);
        const unsigned char *destination = sqlite3_column_text(stmt, 1);
        const unsigned char *reason = sqlite3_column_text(stmt, 2);
        snprintf(buffer[idx].origin, sizeof(buffer[idx].origin), "%s", origin ? (const char *)origin : "");
        snprintf(buffer[idx].destination, sizeof(buffer[idx].destination), "%s", destination ? (const char *)destination : "");
        snprintf(buffer[idx].reason, sizeof(buffer[idx].reason), "%s", reason ? (const char *)reason : "");
        idx++;
    }
    sqlite3_finalize(stmt);
    free(g_block_rules);
    g_block_rules = buffer;
    g_block_rule_count = idx;
    return true;
}

static bool ensure_logistics_metadata(void) {
    if (!g_state.meta_db) return false;
    bool ok = false;
    pthread_mutex_lock(&g_state.store.meta_lock);
    sqlite3 *conn = g_state.meta_db->conn;
    if (!conn) {
        pthread_mutex_unlock(&g_state.store.meta_lock);
        return false;
    }
    if (ensure_best_nodes_seed_locked(conn) &&
        ensure_restrictions_seed_locked(conn) &&
        load_best_nodes_locked(conn) &&
        load_restrictions_locked(conn)) {
        ok = true;
    }
    pthread_mutex_unlock(&g_state.store.meta_lock);
    if (!ok) {
        free(g_best_nodes);
        g_best_nodes = NULL;
        g_best_node_count = 0;
        free(g_block_rules);
        g_block_rules = NULL;
        g_block_rule_count = 0;
    }
    return ok;
}

static bool normalize_iata_code(const char *input, char output[4]) {
    if (!input) return false;
    size_t len = strlen(input);
    size_t start = 0;
    while (start < len && isspace((unsigned char)input[start])) start++;
    size_t end = len;
    while (end > start && isspace((unsigned char)input[end - 1])) end--;
    if (end - start != 3) return false;
    for (size_t i = 0; i < 3; ++i) {
        unsigned char ch = (unsigned char)input[start + i];
        if (!isalnum(ch)) return false;
        output[i] = (char)toupper(ch);
    }
    output[3] = '\0';
    return true;
}

static ssize_t lookup_node_index(const char code[4]) { // Renamed from lookup_airport_index
    if (!code || g_state.store.code_capacity == 0) return -1;
    uint32_t packed = ((uint32_t)(unsigned char)code[0] << 24) |
                      ((uint32_t)(unsigned char)code[1] << 16) |
                      ((uint32_t)(unsigned char)code[2] << 8) |
                      (uint32_t)' ';
    size_t mask = g_state.store.code_capacity - 1;
    size_t slot = (packed * 2654435761u) & mask;
    for (size_t attempt = 0; attempt < g_state.store.code_capacity; ++attempt) {
        uint32_t key = g_state.store.code_keys[slot];
        if (key == packed) {
            size_t idx = g_state.store.code_indices[slot];
            if (idx < g_state.store.node_count) return (ssize_t)idx; // Renamed airport_count to node_count
            break;
        }
        if (key == 0) break;
        slot = (slot + 1) & mask;
    }
    return -1;
}

static size_t collect_forbidden_countries_for_origin(const char *origin_code,
                                                      const char ***out_countries) {
    if (!origin_code || !out_countries) return 0;
    
    // First pass: count unique forbidden countries
    size_t unique_count = 0;
    char **temp_countries = NULL;
    size_t temp_capacity = 8;
    
    temp_countries = malloc(sizeof(char*) * temp_capacity);
    if (!temp_countries) return 0;
    
    for (size_t i = 0; i < g_block_rule_count; ++i) {
        if (strcasecmp(g_block_rules[i].origin, origin_code) != 0) {
            continue;
        }
        
        // Get the country of the destination node
        const char *dest_code = g_block_rules[i].destination;
        if (!dest_code || strlen(dest_code) != 3) continue;
        
        // Find the destination node in the store
        bool found_country = false;
        for (size_t j = 0; j < g_state.store.node_count; ++j) { // Renamed airport_count to node_count
            if (strncasecmp(g_state.store.node_codes[j], dest_code, 3) == 0) { // Renamed airport_codes to node_codes
                const char *country = g_state.store.node_countries[j]; // Renamed airport_countries to node_countries
                if (!country || country[0] == '\0') break;
                
                // Check if already in list
                bool already_added = false;
                for (size_t k = 0; k < unique_count; ++k) {
                    if (strcasecmp(temp_countries[k], country) == 0) {
                        already_added = true;
                        break;
                    }
                }
                
                if (!already_added) {
                    if (unique_count >= temp_capacity) {
                        temp_capacity *= 2;
                        char **new_temp = realloc(temp_countries, sizeof(char*) * temp_capacity);
                        if (!new_temp) {
                            for (size_t k = 0; k < unique_count; ++k) free(temp_countries[k]);
                            free(temp_countries);
                            return 0;
                        }
                        temp_countries = new_temp;
                    }
                    temp_countries[unique_count] = dup_string(country);
                    if (!temp_countries[unique_count]) {
                        for (size_t k = 0; k < unique_count; ++k) free(temp_countries[k]);
                        free(temp_countries);
                        return 0;
                    }
                    unique_count++;
                }
                found_country = true;
                break;
            }
        }
        if (!found_country) {
            // If we can't find the country, skip this rule
            continue;
        }
    }
    
    if (unique_count == 0) {
        free(temp_countries);
        *out_countries = NULL;
        return 0;
    }
    
    // Allocate final array
    const char **result = malloc(sizeof(const char*) * unique_count);
    if (!result) {
        for (size_t k = 0; k < unique_count; ++k) free(temp_countries[k]);
        free(temp_countries);
        return 0;
    }
    
    for (size_t k = 0; k < unique_count; ++k) {
        result[k] = temp_countries[k];
    }
    free(temp_countries);
    
    *out_countries = result;
    return unique_count;
}

static bool is_route_restricted(const char *from, const char *to, const char **reason) {
    if (!from || !to) return false;
    for (size_t i = 0; i < g_block_rule_count; ++i) {
        if (strcasecmp(g_block_rules[i].origin, from) == 0 &&
            strcasecmp(g_block_rules[i].destination, to) == 0) {
            if (reason) {
                *reason = g_block_rules[i].reason;
            }
            return true;
        }
    }
    return false;
}

static void root_handler(cwist_http_request *req, cwist_http_response *res) {
    (void)req;
    cJSON *context = cJSON_CreateObject();
    cJSON_AddStringToObject(context, "app_name", "바보쉽 라우트 콘솔");
    cJSON_AddStringToObject(context, "hero_pill", "Global Freight Control");
    cJSON_AddStringToObject(
        context,
        "hero_body",
        "실시간 항로 지표와 통제된 규제를 결합해, 배송 최단 시간 경로를 한 화면에서 설계하세요.");
    const char *tracker_api_base = getenv("TRACKER_API_BASE");
    if (!tracker_api_base || tracker_api_base[0] == '\0') {
        tracker_api_base = "https://apis.tracker.delivery";
    }
    const char *tracker_api_key = getenv("TRACKER_API_KEY");
    if (!tracker_api_key) tracker_api_key = "";
    const char *ors_api_key = getenv("ORS_API_KEY"); // New: ORS API Key
    if (!ors_api_key) ors_api_key = ""; // Default empty
    cJSON_AddStringToObject(context, "tracker_api_base", tracker_api_base);
    cJSON_AddStringToObject(context, "tracker_api_key", tracker_api_key);
    cJSON_AddStringToObject(context, "ors_api_key", ors_api_key); // New: ORS API Key

    cwist_sstring *rendered = cwist_template_render_file("templates/index.html.tmpl", context);
    cJSON_Delete(context);
    cwist_http_header_add(&res->headers, "Content-Type", "text/html; charset=utf-8");
    if (rendered) {
        cwist_sstring_assign(res->body, rendered->data);
        cwist_sstring_destroy(rendered);
        res->status_code = CWIST_HTTP_OK;
    } else {
        cwist_sstring_assign(res->body, (char *)"<h1>Unable to render UI template</h1>");
        res->status_code = CWIST_HTTP_INTERNAL_ERROR;
    }
}

static void health_handler(cwist_http_request *req, cwist_http_response *res) {
    (void)req;
    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "nodes_loaded", (double)g_state.store.node_count); // Renamed airports_loaded to nodes_loaded, airport_count to node_count
    cJSON_AddNumberToObject(root, "routes_loaded", (double)g_state.store.route_count);
    cJSON_AddBoolToObject(root, "nuke_online", g_state.nuke_conn != NULL);
    cJSON_AddNumberToObject(root, "worker_threads", (double)g_state.store.worker_thread_count);
    write_json_response(res, root, CWIST_HTTP_OK);
}

static void nodes_handler(cwist_http_request *req, cwist_http_response *res) { // Renamed airports_handler to nodes_handler
    const size_t total = g_state.store.node_count; // Renamed airport_count to node_count
    size_t limit = 2048;
    size_t offset = 0;

    const char *limit_param = cwist_query_map_get(req->query_params, "limit");
    if (limit_param) {
        long parsed = strtol(limit_param, NULL, 10);
        if (parsed > 0 && parsed < 65536) {
            limit = (size_t)parsed;
        }
    }
    const char *offset_param = cwist_query_map_get(req->query_params, "offset");
    if (offset_param) {
        long parsed = strtol(offset_param, NULL, 10);
        if (parsed >= 0) {
            offset = (size_t)parsed;
        }
    }
    if (offset >= total) {
        offset = 0;
    }
    const char *query = cwist_query_map_get(req->query_params, "q");
    bool has_query = query && query[0] != '\0';
    char query_buf[8] = {0};
    size_t query_len = 0;
    if (has_query) {
        for (; query_len < sizeof(query_buf) - 1 && query[query_len]; ++query_len) {
            query_buf[query_len] = (char)toupper((unsigned char)query[query_len]);
        }
        query_buf[query_len] = '\0';
    }

    if (!has_query) {
        size_t available = total > offset ? total - offset : 0;
        if (limit > available) {
            limit = available;
        }
    }

    size_t emitted = 0;
    size_t start = has_query ? 0 : offset;
    size_t max_count = total;

    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "total", (double)total);
    cJSON_AddNumberToObject(root, "offset", (double)offset);
    cJSON *arr = cJSON_AddArrayToObject(root, "nodes"); // Renamed airports to nodes

    for (size_t i = start; i < max_count && emitted < limit; ++i) {
        char code[4] = {0};
        memcpy(code, g_state.store.node_codes[i], 3); // Renamed airport_codes to node_codes
        for (size_t c = 0; c < 3; ++c) {
            code[c] = (char)toupper((unsigned char)code[c]);
        }
        if (has_query && strncmp(code, query_buf, query_len) != 0) {
            continue;
        }
        if (!has_query && i < offset) {
            continue;
        }
        cJSON *node = cJSON_CreateObject();
        cJSON_AddNumberToObject(node, "id", (double)g_state.store.node_ids[i]); // Renamed airport_ids to node_ids
        cJSON_AddStringToObject(node, "code", code);
        cJSON_AddNumberToObject(node, "lat", g_state.store.node_lat[i]); // Renamed airport_lat to node_lat
        cJSON_AddNumberToObject(node, "lon", g_state.store.node_lon[i]); // Renamed airport_lon to node_lon
        if (g_state.store.node_countries) { // Renamed airport_countries to node_countries
            cJSON_AddStringToObject(node, "country", g_state.store.node_countries[i]); // Renamed airport_countries to node_countries
        }
        if (g_state.store.node_layers) { // Added layer
            cJSON_AddStringToObject(node, "layer", g_state.store.node_layers + (i * NUKE_LAYER_MAX_LEN));
        }
        cJSON_AddItemToArray(arr, node);
        emitted++;
    }
    cJSON_AddNumberToObject(root, "returned", (double)emitted);
    write_json_response(res, root, CWIST_HTTP_OK);
}

static void routes_handler(cwist_http_request *req, cwist_http_response *res) {
    const char *from = cwist_query_map_get(req->query_params, "from");
    const char *to = cwist_query_map_get(req->query_params, "to");
    if (!from || !to) {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "Missing 'from' or 'to' query param.");
        write_json_response(res, err, CWIST_HTTP_BAD_REQUEST);
        return;
    }
    char from_code[4] = {0};
    char to_code[4] = {0};
    if (!normalize_iata_code(from, from_code) || !normalize_iata_code(to, to_code)) {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "공항 코드를 다시 확인해주세요.");
        write_json_response(res, err, CWIST_HTTP_BAD_REQUEST);
        return;
    }

    if (!nuke_store_has_node(&g_state.store, from_code) || // Renamed nuke_store_has_airport to nuke_store_has_node
        !nuke_store_has_node(&g_state.store, to_code)) { // Renamed nuke_store_has_airport to nuke_store_has_node
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "요청한 공항 코드를 찾을 수 없습니다.");
        write_json_response(res, err, CWIST_HTTP_NOT_FOUND);
        return;
    }

    const char *block_reason = NULL;
    if (is_route_restricted(from_code, to_code, &block_reason)) {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", block_reason ? block_reason : "해당 노선은 제한되어 있습니다.");
        write_json_response(res, err, CWIST_HTTP_FORBIDDEN);
        return;
    }

    size_t max_transfers = 3;
    size_t max_results = 16;
    const char *max_transfer_param = cwist_query_map_get(req->query_params, "maxTransfers");
    const char *max_results_param = cwist_query_map_get(req->query_params, "maxResults");
    if (max_transfer_param) {
        long parsed = strtol(max_transfer_param, NULL, 10);
        if (parsed >= 0) {
            max_transfers = (size_t)parsed;
        }
    }
    if (max_results_param) {
        long parsed = strtol(max_results_param, NULL, 10);
        if (parsed > 0) {
            max_results = (size_t)parsed;
        }
    }
    if (max_results > 128) max_results = 128;
    if (max_results == 0) max_results = 16;

    // Collect forbidden countries based on block rules from the origin
    const char **forbidden_countries = NULL;
    size_t forbidden_count = collect_forbidden_countries_for_origin(from_code, &forbidden_countries);

    nuke_path_buffer_t buffer;
    if (nuke_path_buffer_init(&buffer, max_results) != CWIST_NUKE_OK) {
        if (forbidden_countries) {
            for (size_t i = 0; i < forbidden_count; ++i) {
                free((void*)forbidden_countries[i]);
            }
            free(forbidden_countries);
        }
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "Unable to reserve memory.");
        write_json_response(res, err, CWIST_HTTP_INTERNAL_ERROR);
        return;
    }

    nuke_search_params_t params = {
        .src_code = from_code,
        .dst_code = to_code,
        .max_transfers = max_transfers,
        .max_results = max_results,
        .forbidden_countries = forbidden_countries,
        .forbidden_count = forbidden_count
    };

    int rc = nuke_search_routes(&g_state.store, &params, &buffer);
    if (rc != CWIST_NUKE_OK) {
        nuke_path_buffer_free(&buffer);
        if (forbidden_countries) {
            for (size_t i = 0; i < forbidden_count; ++i) {
                free((void*)forbidden_countries[i]);
            }
            free(forbidden_countries);
        }
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "Route search failed.");
        write_json_response(res, err, CWIST_HTTP_INTERNAL_ERROR);
        return;
    }

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "from", from_code);
    cJSON_AddStringToObject(root, "to", to_code);
    cJSON_AddNumberToObject(root, "results", (double)buffer.count);
    cJSON *paths = cJSON_AddArrayToObject(root, "paths");
    for (size_t i = 0; i < buffer.count; ++i) {
        const nuke_path_result_t *entry = &buffer.items[i];
        cJSON *path = cJSON_CreateObject();
        cJSON_AddNumberToObject(path, "hops", (double)entry->hops);
        cJSON_AddNumberToObject(path, "legs", (double)entry->node_count - 1); // Renamed airport_count to node_count
        cJSON_AddNumberToObject(path, "totalDistanceKm", entry->total_distance_km);
        cJSON_AddNumberToObject(path, "greatCircleKm", entry->great_circle_km);
        cJSON_AddNumberToObject(path, "efficiency", entry->efficiency);
        cJSON_AddStringToObject(path, "layer", entry->layer); // Added layer
        cJSON *nodes = cJSON_AddArrayToObject(path, "nodes"); // Renamed airports to nodes
        for (size_t a = 0; a < entry->node_count; ++a) { // Renamed airport_count to node_count
            cJSON *node = cJSON_CreateObject();
            cJSON_AddNumberToObject(node, "id", (double)entry->node_ids[a]); // Renamed airport_ids to node_ids
            cJSON_AddStringToObject(node, "code", entry->node_codes[a]); // Renamed airport_codes to node_codes
            cJSON_AddItemToArray(nodes, node); // Renamed airports to nodes
        }
        cJSON_AddItemToArray(paths, path);
    }

    write_json_response(res, root, CWIST_HTTP_OK);
    nuke_path_buffer_free(&buffer);
    
    // Clean up forbidden countries array
    if (forbidden_countries) {
        for (size_t i = 0; i < forbidden_count; ++i) {
            free((void*)forbidden_countries[i]);
        }
        free(forbidden_countries);
    }
}

static void direct_handler(cwist_http_request *req, cwist_http_response *res) {
    const char *code_param = cwist_query_map_get(req->query_params, "code");
    char norm[4] = {0};
    if (!normalize_iata_code(code_param, norm)) {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "유효한 3자리 공항 코드를 지정하세요.");
        write_json_response(res, err, CWIST_HTTP_BAD_REQUEST);
        return;
    }
    ssize_t idx = lookup_node_index(norm); // Renamed lookup_airport_index to lookup_node_index
    if (idx < 0) {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "요청한 공항을 찾을 수 없습니다.");
        write_json_response(res, err, CWIST_HTTP_NOT_FOUND);
        return;
    }

    const char **forbidden_countries = NULL;
    size_t forbidden_count = collect_forbidden_countries_for_origin(norm, &forbidden_countries);

    size_t cnt = g_state.store.route_counts[idx];
    size_t off = g_state.store.route_offsets[idx];
    cJSON *root = cJSON_CreateObject();
    cJSON *arr = cJSON_AddArrayToObject(root, "destinations");
    for (size_t i = 0; i < cnt; ++i) {
        size_t dst_idx = g_state.store.adj_dst_indices[off + i];
        if (dst_idx >= g_state.store.node_count) continue; // Renamed airport_count to node_count

        bool skip = false;
        if (forbidden_count > 0 && g_state.store.node_countries) { // Renamed airport_countries to node_countries
            const char *dst_country = g_state.store.node_countries[dst_idx]; // Renamed airport_countries to node_countries
            if (dst_country && dst_country[0] != '\0') {
                for (size_t k = 0; k < forbidden_count; ++k) {
                    if (strcasecmp(dst_country, forbidden_countries[k]) == 0) {
                        skip = true;
                        break;
                    }
                }
            }
        }
        if (skip) continue;

        cJSON *node = cJSON_CreateObject();
        cJSON_AddStringToObject(node, "code", g_state.store.node_codes[dst_idx]); // Renamed airport_codes to node_codes
        cJSON_AddNumberToObject(node, "lat", g_state.store.node_lat[dst_idx]); // Renamed airport_lat to node_lat
        cJSON_AddNumberToObject(node, "lon", g_state.store.node_lon[dst_idx]); // Renamed airport_lon to node_lon
        cJSON_AddNumberToObject(node, "distKm", g_state.store.adj_distance[off + i]);
        cJSON_AddNumberToObject(node, "connections", (double)g_state.store.route_counts[dst_idx]);
        if (g_state.store.node_countries) { // Renamed airport_countries to node_countries
            cJSON_AddStringToObject(node, "country", g_state.store.node_countries[dst_idx]); // Renamed airport_countries to node_countries
        }
        if (g_state.store.node_layers) { // Added layer
            cJSON_AddStringToObject(node, "layer", g_state.store.node_layers + (dst_idx * NUKE_LAYER_MAX_LEN));
        }
        cJSON_AddItemToArray(arr, node);
    }

    write_json_response(res, root, CWIST_HTTP_OK);

    if (forbidden_countries) {
        for (size_t i = 0; i < forbidden_count; ++i) {
            free((void*)forbidden_countries[i]);
        }
        free(forbidden_countries);
    }
}

static void best_handler(cwist_http_request *req, cwist_http_response *res) {
    (void)req;
    if (!g_best_nodes || g_best_node_count == 0) {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "추천 허브 데이터를 로드하지 못했습니다.");
        write_json_response(res, err, CWIST_HTTP_INTERNAL_ERROR);
        return;
    }
    cJSON *root = cJSON_CreateObject();
    cJSON *items = cJSON_AddArrayToObject(root, "items");
    for (size_t i = 0; i < g_best_node_count; ++i) {
        const logistics_best_node_t *node = &g_best_nodes[i];
        cJSON *entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "continentCode", node->continent_code);
        cJSON_AddStringToObject(entry, "continentLabel", node->continent_label);
        cJSON_AddStringToObject(entry, "country", node->country);
        cJSON_AddStringToObject(entry, "isoCode", node->iso_code);
        cJSON_AddStringToObject(entry, "anchorNode", node->anchor_node); // Renamed anchorAirport to anchorNode
        cJSON_AddNumberToObject(entry, "avgHours", node->avg_hours);
        cJSON_AddNumberToObject(entry, "reliability", node->reliability);
        cJSON_AddStringToObject(entry, "notes", node->notes);
        cJSON_AddStringToObject(entry, "layer", node->layer); // Added layer
        cJSON_AddItemToArray(items, entry);
    }
    write_json_response(res, root, CWIST_HTTP_OK);
}

static void tracking_analyze_handler(cwist_http_request *req, cwist_http_response *res) {
    if (!req->body || !req->body->data || req->body->data[0] == '\0') {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "분석할 로그 본문이 필요합니다.");
        write_json_response(res, err, CWIST_HTTP_BAD_REQUEST);
        return;
    }
    cJSON *input = cJSON_Parse(req->body->data);
    if (!input) {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "요청 본문이 유효한 JSON이 아닙니다.");
        write_json_response(res, err, CWIST_HTTP_BAD_REQUEST);
        return;
    }
    const cJSON *log_node = cJSON_GetObjectItemCaseSensitive(input, "log");
    const char *payload = (cJSON_IsString(log_node) && log_node->valuestring) ? log_node->valuestring : NULL;
    if (!payload || payload[0] == '\0') {
        cJSON_Delete(input);
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "log 필드에 분석 문자열을 넣어주세요.");
        write_json_response(res, err, CWIST_HTTP_BAD_REQUEST);
        return;
    }

    logistics_tracking_result_t result;
    bool ok = logistics_analyze_tracking(payload, &result);
    cJSON_Delete(input);
    if (!ok) {
        cJSON *err = cJSON_CreateObject();
        cJSON_AddStringToObject(err, "error", "분석 가능한 위치 이벤트가 없습니다.");
        write_json_response(res, err, CWIST_HTTP_BAD_REQUEST);
        return;
    }

    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "nodes", (double)result.node_count);
    cJSON_AddNumberToObject(root, "directKm", result.direct_km);
    cJSON_AddNumberToObject(root, "traveledKm", result.traveled_km);
    cJSON_AddNumberToObject(root, "dwellPenalty", result.dwell_penalty);
    cJSON_AddNumberToObject(root, "routePenalty", result.route_penalty);
    cJSON_AddNumberToObject(root, "idiotScore", result.edi_score);
    write_json_response(res, root, CWIST_HTTP_OK);
}

int main(void) {
    const char *nuke_path = getenv("NUKE_DB_PATH");
    if (!nuke_path) nuke_path = "data/nuke_routes.db";
    const char *meta_path = getenv("META_DB_PATH");
    if (!meta_path) meta_path = "data/meta.db";

    cwist_error_t meta_err = cwist_db_open(&g_state.meta_db, meta_path);
    if (meta_err.error.err_i16 < 0) {
        fprintf(stderr, "[NUKEDB] Failed to open metadata database at %s\n", meta_path);
        cleanup();
        return 1;
    }

    int nuke_rc = cwist_nuke_init(nuke_path, 5000);
    if (nuke_rc != CWIST_NUKE_OK) {
        fprintf(stderr, "[NUKEDB] Unable to hydrate Nuke DB from %s (code=%d)\n", nuke_path, nuke_rc);
        cleanup();
        return 1;
    }
    g_state.nuke_conn = cwist_nuke_get_db();
    if (!g_state.nuke_conn) {
        fprintf(stderr, "[NUKEDB] cwist_nuke_get_db returned NULL\n");
        cleanup();
        return 1;
    }

    if (nuke_flight_store_init(&g_state.store, g_state.nuke_conn, g_state.meta_db, 4) != CWIST_NUKE_OK) {
        fprintf(stderr, "[NUKEDB] Failed to initialize flight store.\n");
        cleanup();
        return 1;
    }

    if (!ensure_logistics_metadata()) {
        fprintf(stderr, "[NUKEDB] Failed to hydrate logistics metadata tables.\n");
    }

    atexit(cleanup);
    signal(SIGINT, handle_sigint);
    signal(SIGTERM, handle_sigint);

    g_app = cwist_app_create();
    if (!g_app) {
        fprintf(stderr, "[NUKEDB] Unable to create CWIST app.\n");
        cleanup();
        return 1;
    }

    cwist_app_get(g_app, "/", root_handler);
    cwist_app_get(g_app, "/health", health_handler);
    cwist_app_get(g_app, "/routes", routes_handler);
    cwist_app_get(g_app, "/nodes", nodes_handler); // Renamed /airports to /nodes, airports_handler to nodes_handler
    cwist_app_get(g_app, "/best", best_handler);
    cwist_app_get(g_app, "/direct", direct_handler);
    cwist_app_post(g_app, "/tracking/analyze", tracking_analyze_handler);
    cwist_app_static(g_app, "/docs", "docs");

    const char *port_env = getenv("PORT");
    int port = port_env ? atoi(port_env) : 8080;
    if (port <= 0) port = 8080;

    printf("[NUKEDB] Listening on port %d\n", port);
    int rc = cwist_app_listen(g_app, port);
    if (rc != 0) {
        fprintf(stderr, "[NUKEDB] cwist_app_listen failed (rc=%d)\n", rc);
    }
    cleanup();
    return rc == 0 ? 0 : 1;
}
