#ifndef LOGISTICS_ENGINE_H
#define LOGISTICS_ENGINE_H

#include "nuke_flight.h"

typedef struct logistics_tracking_result {
    size_t node_count;
    float direct_km;
    float traveled_km;
    float dwell_penalty;
    float route_penalty;
    float edi_score;
} logistics_tracking_result_t;

#ifdef __cplusplus
extern "C" {
#endif

bool logistics_analyze_tracking(const char *raw, logistics_tracking_result_t *out);
const char *logistics_analyze_tracking_json(const char *raw);

#ifndef __EMSCRIPTEN__
const nuke_flight_store_t *logistics_native_get_store(void);
#endif

#ifdef __cplusplus
}
#endif

#endif /* LOGISTICS_ENGINE_H */
