#include <stdio.h>
#include <stddef.h>
#include "lib/libttak/internal/app_types.h"
int main(void) {
    printf("sizeof=%zu\n", sizeof(ttak_mem_header_t));
    printf("offset magic=%zu\n", offsetof(ttak_mem_header_t, magic));
    printf("offset checksum=%zu\n", offsetof(ttak_mem_header_t, checksum));
    printf("offset created=%zu\n", offsetof(ttak_mem_header_t, created_tick));
    printf("offset expires=%zu\n", offsetof(ttak_mem_header_t, expires_tick));
    printf("offset access=%zu\n", offsetof(ttak_mem_header_t, access_count));
    printf("offset pin=%zu\n", offsetof(ttak_mem_header_t, pin_count));
    printf("offset size=%zu\n", offsetof(ttak_mem_header_t, size));
    printf("offset lock=%zu\n", offsetof(ttak_mem_header_t, lock));
    printf("offset freed=%zu\n", offsetof(ttak_mem_header_t, freed));
    printf("offset strict=%zu\n", offsetof(ttak_mem_header_t, strict_check));
    printf("offset start_canary=%zu\n", offsetof(ttak_mem_header_t, canary_start));
    printf("offset end_canary=%zu\n", offsetof(ttak_mem_header_t, canary_end));
    return 0;
}
