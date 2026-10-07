/*
 * wasi_main.c — WASI CLI driver for the baboship kernels.
 *
 * Runs the same route kernel that powers the browser WASM build, but under a
 * WASI runtime (wasmtime), so the full search logic is usable from servers,
 * CI jobs, and edge runtimes without a browser or Emscripten glue.
 *
 * Usage:
 *   wasmtime run --dir . nukedb_wasi.wasm routes <blob> <FROM> <TO> [maxTransfers]
 *   wasmtime run --dir . nukedb_wasi.wasm gc <lat1> <lon1> <lat2> <lon2>
 *   wasmtime run --dir . nukedb_wasi.wasm health <blob>
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern int nuke_wasm_init(void);
extern int nuke_wasm_load_data(const void *blob, size_t size);
extern const char *nuke_wasm_search_routes_json(const char *from, const char *to, int max_transfers);
extern const char *nuke_wasm_get_health_json(void);
extern const char *nuke_wasm_get_nodes_json(void);
extern double nuke_wasm_gc_distance(double lat1, double lon1, double lat2, double lon2);

static unsigned char *read_file(const char *path, size_t *out_size) {
    FILE *fp = fopen(path, "rb");
    if (!fp) return NULL;
    if (fseek(fp, 0, SEEK_END) != 0) { fclose(fp); return NULL; }
    long len = ftell(fp);
    if (len <= 0) { fclose(fp); return NULL; }
    rewind(fp);
    unsigned char *buf = malloc((size_t)len);
    if (!buf) { fclose(fp); return NULL; }
    size_t got = fread(buf, 1, (size_t)len, fp);
    fclose(fp);
    if (got != (size_t)len) { free(buf); return NULL; }
    *out_size = got;
    return buf;
}

static int cmd_routes(const char *blob_path, const char *from, const char *to,
                      int max_transfers) {
    size_t size = 0;
    unsigned char *blob = read_file(blob_path, &size);
    if (!blob) {
        fprintf(stderr, "blob 읽기 실패: %s\n", blob_path);
        return 2;
    }
    int rc = nuke_wasm_load_data(blob, size);
    if (rc != 0) {
        fprintf(stderr, "blob 로드 실패 (code=%d)\n", rc);
        free(blob);
        return 3;
    }
    const char *json = nuke_wasm_search_routes_json(from, to, max_transfers);
    fputs(json ? json : "{\"paths\":[]}", stdout);
    fputc('\n', stdout);
    free(blob);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: nukedb_wasi routes <blob> <FROM> <TO> [maxTransfers] | gc <lat1> <lon1> <lat2> <lon2> | health <blob> | nodes <blob>\n");
        return 1;
    }
    if (strcmp(argv[1], "routes") == 0) {
        if (argc < 5) { fprintf(stderr, "routes: <blob> <FROM> <TO> 필요\n"); return 1; }
        int max_transfers = argc > 5 ? atoi(argv[5]) : 3;
        return cmd_routes(argv[2], argv[3], argv[4], max_transfers);
    }
    if (strcmp(argv[1], "gc") == 0) {
        if (argc < 6) { fprintf(stderr, "gc: <lat1> <lon1> <lat2> <lon2> 필요\n"); return 1; }
        double d = nuke_wasm_gc_distance(atof(argv[2]), atof(argv[3]), atof(argv[4]), atof(argv[5]));
        printf("%.3f\n", d);
        return 0;
    }
    if (strcmp(argv[1], "health") == 0 || strcmp(argv[1], "nodes") == 0) {
        if (argc < 3) { fprintf(stderr, "%s: <blob> 필요\n", argv[1]); return 1; }
        size_t size = 0;
        unsigned char *blob = read_file(argv[2], &size);
        if (!blob) { fprintf(stderr, "blob 읽기 실패: %s\n", argv[2]); return 2; }
        int rc = nuke_wasm_load_data(blob, size);
        if (rc != 0) { fprintf(stderr, "blob 로드 실패 (code=%d)\n", rc); free(blob); return 3; }
        const char *json = (strcmp(argv[1], "health") == 0)
            ? nuke_wasm_get_health_json()
            : nuke_wasm_get_nodes_json();
        fputs(json ? json : "{}", stdout);
        fputc('\n', stdout);
        free(blob);
        return 0;
    }
    fprintf(stderr, "알 수 없는 명령: %s\n", argv[1]);
    return 1;
}
