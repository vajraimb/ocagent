#define _GNU_SOURCE
#include <caml/memory.h>
#include <caml/mlvalues.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/resource.h>
#include <sys/stat.h>
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

value ocagent_limits_must_fail(value unit) {
  (void)unit;
  struct rlimit limit;
  limit.rlim_cur = 1;
  limit.rlim_max = 1;
  if (setrlimit(-1, &limit) == 0) return Val_int(0);
  return Val_int(-errno);
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

static int copy_path(value v, char *dst, size_t n) {
  size_t len = caml_string_length(v);
  if (len + 1 > n) return -1;
  memcpy(dst, String_val(v), len);
  dst[len] = 0;
  return 0;
}

static void mkdir_p(const char *path) {
  char buf[4096];
  snprintf(buf, sizeof buf, "%s", path);
  for (char *p = buf + 1; *p; p++) {
    if (*p == '/') {
      *p = 0;
      mkdir(buf, 0755);
      *p = '/';
    }
  }
  mkdir(buf, 0755);
}

static int bind_at(const char *jail, const char *src, int readonly) {
  struct stat st;
  if (stat(src, &st) != 0) return -errno;
  char dst[4096];
  if (snprintf(dst, sizeof dst, "%s%s", jail, src) >= (int)sizeof dst) return -ENAMETOOLONG;
  if (S_ISDIR(st.st_mode)) {
    mkdir_p(dst);
    if (mount(src, dst, NULL, MS_BIND | MS_REC, NULL) != 0) return -errno;
  } else {
    char parent[4096];
    snprintf(parent, sizeof parent, "%s", dst);
    char *slash = strrchr(parent, '/');
    if (slash == NULL) return -EINVAL;
    *slash = 0;
    mkdir_p(parent);
    int fd = open(dst, O_CREAT | O_WRONLY, 0644);
    if (fd < 0) return -errno;
    close(fd);
    if (mount(src, dst, NULL, MS_BIND, NULL) != 0) return -errno;
  }
  if (readonly && mount(NULL, dst, NULL, MS_REMOUNT | MS_BIND | MS_RDONLY, NULL) != 0) return -errno;
  return 0;
}

static int write_text(const char *path, const char *text) {
  int fd = open(path, O_WRONLY);
  if (fd < 0) return -errno;
  size_t len = strlen(text);
  ssize_t n = write(fd, text, len);
  int err = errno;
  close(fd);
  if (n < 0 || (size_t)n != len) return -err;
  return 0;
}

value ocagent_enter_jail(value v_dir, value v_ocamlc, value v_ocamlrun, value v_stdlib) {
  CAMLparam4(v_dir, v_ocamlc, v_ocamlrun, v_stdlib);
  char dir[4096], ocamlc[4096], ocamlrun[4096], stdlib[4096], jail[128], map[64];
  if (copy_path(v_dir, dir, sizeof dir) || copy_path(v_ocamlc, ocamlc, sizeof ocamlc)
      || copy_path(v_ocamlrun, ocamlrun, sizeof ocamlrun) || copy_path(v_stdlib, stdlib, sizeof stdlib))
    CAMLreturn(Val_int(-ENAMETOOLONG));
  uid_t uid = getuid();
  gid_t gid = getgid();
  if (unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWNET) != 0) CAMLreturn(Val_int(-errno));
  int rc = write_text("/proc/self/setgroups", "deny");
  if (rc != 0) CAMLreturn(Val_int(rc));
  snprintf(map, sizeof map, "0 %u 1\n", uid);
  rc = write_text("/proc/self/uid_map", map);
  if (rc != 0) CAMLreturn(Val_int(rc));
  snprintf(map, sizeof map, "0 %u 1\n", gid);
  rc = write_text("/proc/self/gid_map", map);
  if (rc != 0) CAMLreturn(Val_int(rc));
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) CAMLreturn(Val_int(-errno));
  snprintf(jail, sizeof jail, "/tmp/ocagent-jail-%d", getpid());
  if (mkdir(jail, 0700) != 0 && errno != EEXIST) CAMLreturn(Val_int(-errno));
  if (mount("tmpfs", jail, "tmpfs", 0, "size=64m") != 0) CAMLreturn(Val_int(-errno));
  const char *ro[] = { "/lib64/ld-linux-x86-64.so.2", "/lib/x86_64-linux-gnu", "/etc/ld.so.cache", ocamlc, ocamlrun,
                       stdlib, NULL };
  for (int i = 0; ro[i] != NULL; i++) {
    rc = bind_at(jail, ro[i], 1);
    if (rc != 0) CAMLreturn(Val_int(rc));
  }
  rc = bind_at(jail, dir, 0);
  if (rc != 0) CAMLreturn(Val_int(rc));
  if (chdir(jail) != 0) CAMLreturn(Val_int(-errno));
  if (mount(".", "/", NULL, MS_MOVE, NULL) != 0) CAMLreturn(Val_int(-errno));
  if (chroot(".") != 0) CAMLreturn(Val_int(-errno));
  if (chdir("/") != 0) CAMLreturn(Val_int(-errno));
  CAMLreturn(Val_int(0));
}
