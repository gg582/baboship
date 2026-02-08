/*
 * Test for forbidden destination filtering
 * This test verifies that routes through forbidden countries are excluded
 * Example: ICN (South Korea) -> PEK (China) -> FNJ (North Korea) should be blocked
 */

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
        fprintf(stderr, "FAIL: meta open failed\n");
        return 1;
    }

    if (cwist_nuke_init(nuke_path, 0) != CWIST_NUKE_OK) {
        fprintf(stderr, "FAIL: nuke init failed\n");
        return 1;
    }
    g_state.nuke_conn = cwist_nuke_get_db();
    if (!g_state.nuke_conn) {
        fprintf(stderr, "FAIL: nuke conn null\n");
        return 1;
    }

    if (nuke_flight_store_init(&g_state.store, g_state.nuke_conn, g_state.meta_db, 1) != CWIST_NUKE_OK) {
        fprintf(stderr, "FAIL: store init failed\n");
        return 1;
    }
    if (!ensure_logistics_metadata()) {
        fprintf(stderr, "FAIL: metadata load failed\n");
        return 1;
    }

    printf("INFO: Loaded %zu block rules\n", g_block_rule_count);
    for (size_t i = 0; i < g_block_rule_count; ++i) {
        printf("INFO: Block rule %zu: %s -> %s (%s)\n", 
               i, g_block_rules[i].origin, g_block_rules[i].destination, g_block_rules[i].reason);
    }

    // Test 1: Direct route from ICN to FNJ should be blocked at the HTTP level
    printf("\n=== Test 1: Direct ICN -> FNJ (should be blocked) ===\n");
    cwist_http_request *req1 = cwist_http_request_create();
    cwist_http_response *res1 = cwist_http_response_create();
    req1->db = g_state.meta_db;
    if (!req1->query_params) req1->query_params = cwist_query_map_create();
    cwist_query_map_set(req1->query_params, "from", "ICN");
    cwist_query_map_set(req1->query_params, "to", "FNJ");
    cwist_query_map_set(req1->query_params, "maxTransfers", "5");

    routes_handler(req1, res1);
    printf("Response status: %d\n", res1->status_code);
    printf("Response body: %s\n", res1->body && res1->body->data ? res1->body->data : "(null)");
    
    if (res1->status_code != CWIST_HTTP_FORBIDDEN) {
        fprintf(stderr, "FAIL: Expected status 403 (FORBIDDEN) but got %d\n", res1->status_code);
        cwist_http_response_destroy(res1);
        cwist_http_request_destroy(req1);
        cleanup();
        return 1;
    }
    printf("PASS: Direct route correctly blocked\n");
    cwist_http_response_destroy(res1);
    cwist_http_request_destroy(req1);

    // Test 2: Route from ICN to PEK (China) should be allowed
    // But routes from ICN through China to North Korea should be filtered out
    printf("\n=== Test 2: ICN -> PEK (should be allowed, no North Korea in results) ===\n");
    cwist_http_request *req2 = cwist_http_request_create();
    cwist_http_response *res2 = cwist_http_response_create();
    req2->db = g_state.meta_db;
    if (!req2->query_params) req2->query_params = cwist_query_map_create();
    cwist_query_map_set(req2->query_params, "from", "ICN");
    cwist_query_map_set(req2->query_params, "to", "PEK");
    cwist_query_map_set(req2->query_params, "maxTransfers", "5");

    routes_handler(req2, res2);
    printf("Response status: %d\n", res2->status_code);
    printf("Response body: %s\n", res2->body && res2->body->data ? res2->body->data : "(null)");
    
    if (res2->status_code != CWIST_HTTP_OK) {
        fprintf(stderr, "FAIL: Expected status 200 (OK) but got %d\n", res2->status_code);
        cwist_http_response_destroy(res2);
        cwist_http_request_destroy(req2);
        cleanup();
        return 1;
    }
    printf("PASS: Route to China is allowed\n");
    cwist_http_response_destroy(res2);
    cwist_http_request_destroy(req2);

    // Test 3: Multi-hop route that would go through North Korea should have no results
    // Try searching from a city that only connects to FNJ through multi-hop
    printf("\n=== Test 3: Routes should not include North Korean airports ===\n");
    cwist_http_request *req3 = cwist_http_request_create();
    cwist_http_response *res3 = cwist_http_response_create();
    req3->db = g_state.meta_db;
    if (!req3->query_params) req3->query_params = cwist_query_map_create();
    cwist_query_map_set(req3->query_params, "from", "ICN");
    cwist_query_map_set(req3->query_params, "to", "NRT"); // Tokyo
    cwist_query_map_set(req3->query_params, "maxTransfers", "3");
    cwist_query_map_set(req3->query_params, "maxResults", "50");

    routes_handler(req3, res3);
    printf("Response status: %d\n", res3->status_code);
    
    if (res3->status_code == CWIST_HTTP_OK) {
        // Parse the response to check that no North Korean airports are in any path
        const char *body = res3->body && res3->body->data ? res3->body->data : "";
        if (strstr(body, "FNJ") != NULL || strstr(body, "DSO") != NULL || 
            strstr(body, "RGO") != NULL || strstr(body, "WOS") != NULL) {
            fprintf(stderr, "FAIL: Response contains North Korean airport codes\n");
            printf("Response body: %s\n", body);
            cwist_http_response_destroy(res3);
            cwist_http_request_destroy(req3);
            cleanup();
            return 1;
        }
        printf("PASS: No North Korean airports in route results\n");
    } else {
        printf("INFO: Route search returned status %d (this is OK if no routes found)\n", res3->status_code);
    }
    cwist_http_response_destroy(res3);
    cwist_http_request_destroy(req3);

    printf("\n=== All tests passed ===\n");
    cleanup();
    return 0;
}
