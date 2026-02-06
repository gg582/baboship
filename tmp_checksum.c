#include <stdio.h>
#include <stdint.h>
#include "lib/libttak/internal/app_types.h"
int main(void) {
    ttak_mem_header_t h = {0};
    h.magic = TTAK_MAGIC_NUMBER;
    h.created_tick = 0x00000000015148e4ULL;
    h.expires_tick = 0xffffffffffffffffULL;
    h.size = 0x18;
    h.should_join = 0;
    h.strict_check = 1;
    h.is_root = 1;
    h.canary_start = 0xdeadbeefdeadbeefULL;
    h.canary_end = 0xbeefdeadbeefdeadULL;
    uint32_t checksum = ttak_calc_header_checksum(&h);
    printf("calc=%#x\n", checksum);
    return 0;
}
