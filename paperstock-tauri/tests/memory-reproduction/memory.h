#include <libproc.h>
#include <sys/resource.h>
#include <stdint.h>

static inline uint64_t test_footprint(int pid) {
    struct rusage_info_v4 info = {0};
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&info) != 0) return 0;
    return info.ri_phys_footprint;
}
static inline uint64_t test_resident(int pid) {
    struct rusage_info_v4 info = {0};
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&info) != 0) return 0;
    return info.ri_resident_size;
}
