#define _GNU_SOURCE
#include <caml/mlvalues.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <unistd.h>

value ocagent_limit_compiler(value cpu_seconds, value as_bytes, value file_bytes) {
  struct rlimit limit;
  limit.rlim_cur = Long_val(cpu_seconds);
  limit.rlim_max = Long_val(cpu_seconds);
  if (setrlimit(RLIMIT_CPU, &limit) != 0) return Val_int(-errno);
  limit.rlim_cur = Long_val(as_bytes);
  limit.rlim_max = Long_val(as_bytes);
  if (setrlimit(RLIMIT_AS, &limit) != 0) return Val_int(-errno);
  limit.rlim_cur = Long_val(file_bytes);
  limit.rlim_max = Long_val(file_bytes);
  if (setrlimit(RLIMIT_FSIZE, &limit) != 0) return Val_int(-errno);
  if (setpgid(0, 0) != 0) return Val_int(-errno);
  return Val_int(0);
}

value ocagent_close_extra_fds(value unit) {
  (void)unit;
  DIR *dir = opendir("/proc/self/fd");
  if (dir == NULL) return Val_int(-errno);
  int self = dirfd(dir);
  struct dirent *ent;
  while ((ent = readdir(dir)) != NULL) {
    char *end = NULL;
    long fd = strtol(ent->d_name, &end, 10);
    if (end == ent->d_name || *end != '\0') continue;
    if (fd > 2 && fd != self) close((int)fd);
  }
  closedir(dir);
  return Val_int(0);
}

value ocagent_kill_group(value pid) {
  if (kill(-Int_val(pid), SIGKILL) != 0) return Val_int(-errno);
  return Val_int(0);
}
