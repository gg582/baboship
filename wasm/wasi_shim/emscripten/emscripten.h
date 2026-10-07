/* Minimal emscripten shim for WASI builds: EMSCRIPTEN_KEEPALIVE only. */
#ifndef WASI_SHIM_EMSCRIPTEN_H
#define WASI_SHIM_EMSCRIPTEN_H

#ifndef EMSCRIPTEN_KEEPALIVE
#define EMSCRIPTEN_KEEPALIVE __attribute__((used))
#endif

#endif /* WASI_SHIM_EMSCRIPTEN_H */
