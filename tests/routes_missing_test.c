#define static
#define main nukedb_app_entry
#include "../src/server.c"
#undef static
#undef main

int main(void) {
    const char *nuke_path = "data/nuke_routes.db";
    const char *meta_path = "data/meta.db";

    cwist_error_t meta_err = cwist_db_open(&g_state.meta_db, meta_path);
    if (meta_err.error.err_i16 < 0) {
        fprintf(stderr, "meta open failed\n");
        return 1;
    }

    if (cwist_nuke_init(nuke_path, 0) != CWIST_NUKE_OK) {
        fprintf(stderr, "nuke init failed\n");
        return 1;
    }
    g_state.nuke_conn = cwist_nuke_get_db();
    if (!g_state.nuke_conn) {
        fprintf(stderr, "nuke conn null\n");
        return 1;
    }

    if (nuke_flight_store_init(&g_state.store, g_state.nuke_conn, g_state.meta_db, 1) != CWIST_NUKE_OK) {
        fprintf(stderr, "store init failed\n");
        return 1;
    }
    ensure_logistics_metadata();

    cwist_http_request *req = cwist_http_request_create();
    cwist_http_response *res = cwist_http_response_create();
    req->db = g_state.meta_db;
    if (!req->query_params) req->query_params = cwist_query_map_create();
    cwist_query_map_set(req->query_params, "from", "ZZZ");
    cwist_query_map_set(req->query_params, "to", "XXX");

    routes_handler(req, res);
    printf("status=%d body=%s\n", res->status_code, res->body && res->body->data ? res->body->data : "(null)");

    cwist_http_response_destroy(res);
    cwist_http_request_destroy(req);
    cleanup();
    return 0;
}
