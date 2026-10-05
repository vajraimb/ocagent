#define _GNU_SOURCE
#include <caml/alloc.h>
#include <caml/fail.h>
#include <caml/memory.h>
#include <caml/mlvalues.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define ST_NAMESPACE 3
#define ST_UID 4
#define ST_GID 5
#define ST_MOUNT 6
#define ST_CHROOT 7
#define ST_CHDIR 8
#define ST_LANDLOCK 9

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif

#define LL_FS_EXECUTE (1ULL << 0)
#define LL_FS_WRITE_FILE (1ULL << 1)
#define LL_FS_READ_FILE (1ULL << 2)
#define LL_FS_READ_DIR (1ULL << 3)
#define LL_FS_REMOVE_DIR (1ULL << 4)
#define LL_FS_REMOVE_FILE (1ULL << 5)
#define LL_FS_MAKE_CHAR (1ULL << 6)
#define LL_FS_MAKE_DIR (1ULL << 7)
#define LL_FS_MAKE_REG (1ULL << 8)
#define LL_FS_MAKE_SOCK (1ULL << 9)
#define LL_FS_MAKE_FIFO (1ULL << 10)
#define LL_FS_MAKE_BLOCK (1ULL << 11)
#define LL_FS_MAKE_SYM (1ULL << 12)
#define LL_FS_REFER (1ULL << 13)
#define LL_FS_TRUNCATE (1ULL << 14)
#define LL_FS_IOCTL_DEV (1ULL << 15)
#define LL_NET_BIND_TCP (1ULL << 0)
#define LL_NET_CONNECT_TCP (1ULL << 1)
#define LL_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define LL_SCOPE_SIGNAL (1ULL << 1)
#define LL_RULE_PATH_BENEATH 1
#define LL_CREATE_VERSION (1U << 0)

static int fail_stage(int stage) { return stage * 1000 + errno; }

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

value ocagent_close_extra_fds(value keep) {
  int keep_fd = Int_val(keep);
  DIR *dir = opendir("/proc/self/fd");
  if (dir == NULL) return Val_int(-errno);
  int self = dirfd(dir);
  struct dirent *ent;
  while ((ent = readdir(dir)) != NULL) {
    char *end = NULL;
    long fd = strtol(ent->d_name, &end, 10);
    if (end == ent->d_name || *end != '\0') continue;
    if (fd > 2 && fd != self && fd != keep_fd) close((int)fd);
  }
  closedir(dir);
  return Val_int(0);
}

value ocagent_kill_group(value pid) {
  if (kill(-Int_val(pid), SIGKILL) != 0) return Val_int(-errno);
  return Val_int(0);
}

value ocagent_getpgid(value pid) {
  int pgid = getpgid(Int_val(pid));
  if (pgid < 0) caml_failwith("getpgid");
  return Val_int(pgid);
}

value ocagent_realpath(value path) {
  CAMLparam1(path);
  char buf[PATH_MAX];
  if (realpath(String_val(path), buf) == NULL) caml_failwith("realpath");
  CAMLreturn(caml_copy_string(buf));
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

static int write_text(const char *path, const char *text) {
  int fd = open(path, O_WRONLY);
  if (fd < 0) return -1;
  size_t len = strlen(text);
  ssize_t n = write(fd, text, len);
  int saved = errno;
  close(fd);
  if (n < 0 || (size_t)n != len) {
    errno = saved;
    return -1;
  }
  return 0;
}

static int bind_at(const char *jail, const char *src, int readonly) {
  struct stat st;
  if (stat(src, &st) != 0) return -1;
  char dst[4096];
  if (snprintf(dst, sizeof dst, "%s%s", jail, src) >= (int)sizeof dst) {
    errno = ENAMETOOLONG;
    return -1;
  }
  if (S_ISDIR(st.st_mode)) {
    mkdir_p(dst);
    if (mount(src, dst, NULL, MS_BIND | MS_REC, NULL) != 0) return -1;
  } else {
    char parent[4096];
    snprintf(parent, sizeof parent, "%s", dst);
    char *slash = strrchr(parent, '/');
    if (slash == NULL) {
      errno = EINVAL;
      return -1;
    }
    *slash = 0;
    mkdir_p(parent);
    int fd = open(dst, O_CREAT | O_WRONLY, 0644);
    if (fd < 0) return -1;
    close(fd);
    if (mount(src, dst, NULL, MS_BIND, NULL) != 0) return -1;
  }
  if (readonly && mount(NULL, dst, NULL, MS_REMOUNT | MS_BIND | MS_RDONLY, NULL) != 0) return -1;
  return 0;
}

value ocagent_enter_userns(value v_work, value v_snap) {
  CAMLparam2(v_work, v_snap);
  char work[4096], snap[4096], jail[128], map[64];
  if (copy_path(v_work, work, sizeof work) || copy_path(v_snap, snap, sizeof snap)) CAMLreturn(Val_int(ST_MOUNT * 1000 + ENAMETOOLONG));
  uid_t uid = getuid();
  gid_t gid = getgid();
  if (unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWNET) != 0) CAMLreturn(Val_int(fail_stage(ST_NAMESPACE)));
  if (write_text("/proc/self/setgroups", "deny") != 0) CAMLreturn(Val_int(fail_stage(ST_GID)));
  snprintf(map, sizeof map, "0 %u 1\n", uid);
  if (write_text("/proc/self/uid_map", map) != 0) CAMLreturn(Val_int(fail_stage(ST_UID)));
  snprintf(map, sizeof map, "0 %u 1\n", gid);
  if (write_text("/proc/self/gid_map", map) != 0) CAMLreturn(Val_int(fail_stage(ST_GID)));
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) CAMLreturn(Val_int(fail_stage(ST_MOUNT)));
  snprintf(jail, sizeof jail, "/tmp/ocagent-jail-%d", getpid());
  if (mkdir(jail, 0700) != 0 && errno != EEXIST) CAMLreturn(Val_int(fail_stage(ST_MOUNT)));
  if (mount("tmpfs", jail, "tmpfs", 0, "size=64m") != 0) CAMLreturn(Val_int(fail_stage(ST_MOUNT)));
  if (bind_at(jail, snap, 1) != 0) CAMLreturn(Val_int(fail_stage(ST_MOUNT)));
  if (bind_at(jail, work, 0) != 0) CAMLreturn(Val_int(fail_stage(ST_MOUNT)));
  if (chdir(jail) != 0) CAMLreturn(Val_int(fail_stage(ST_CHDIR)));
  if (mount(".", "/", NULL, MS_MOVE, NULL) != 0) CAMLreturn(Val_int(fail_stage(ST_MOUNT)));
  if (chroot(".") != 0) CAMLreturn(Val_int(fail_stage(ST_CHROOT)));
  if (chdir("/") != 0) CAMLreturn(Val_int(fail_stage(ST_CHDIR)));
  CAMLreturn(Val_int(0));
}

struct ll_attr6 {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};

struct ll_attr4 {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
};

struct ll_path {
  uint64_t allowed_access;
  int parent_fd;
};

static int ll_add(int ruleset, int fd, uint64_t access) {
  struct ll_path path;
  path.allowed_access = access;
  path.parent_fd = fd;
  if (syscall(__NR_landlock_add_rule, ruleset, LL_RULE_PATH_BENEATH, &path, 0) != 0) return -1;
  return 0;
}

value ocagent_enter_landlock(value v_work, value v_snap) {
  CAMLparam2(v_work, v_snap);
  char work[4096], snap[4096];
  if (copy_path(v_work, work, sizeof work) || copy_path(v_snap, snap, sizeof snap)) CAMLreturn(Val_int(ST_LANDLOCK * 1000 + ENAMETOOLONG));
  int abi = (int)syscall(__NR_landlock_create_ruleset, NULL, 0, LL_CREATE_VERSION);
  if (abi < 4) {
    if (abi < 0) CAMLreturn(Val_int(fail_stage(ST_LANDLOCK)));
    errno = ENOTSUP;
    CAMLreturn(Val_int(fail_stage(ST_LANDLOCK)));
  }
  uint64_t fs = LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE | LL_FS_READ_DIR | LL_FS_REMOVE_DIR | LL_FS_REMOVE_FILE
                | LL_FS_MAKE_CHAR | LL_FS_MAKE_DIR | LL_FS_MAKE_REG | LL_FS_MAKE_SOCK | LL_FS_MAKE_FIFO | LL_FS_MAKE_BLOCK
                | LL_FS_MAKE_SYM | LL_FS_REFER | LL_FS_TRUNCATE;
  if (abi >= 5) fs |= LL_FS_IOCTL_DEV;
  int ruleset = -1;
  if (abi >= 6) {
    struct ll_attr6 attr;
    memset(&attr, 0, sizeof attr);
    attr.handled_access_fs = fs;
    attr.handled_access_net = LL_NET_BIND_TCP | LL_NET_CONNECT_TCP;
    attr.scoped = LL_SCOPE_ABSTRACT_UNIX_SOCKET | LL_SCOPE_SIGNAL;
    ruleset = (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof attr, 0);
  }
  if (ruleset < 0) {
    struct ll_attr4 attr;
    memset(&attr, 0, sizeof attr);
    attr.handled_access_fs = fs;
    attr.handled_access_net = LL_NET_BIND_TCP | LL_NET_CONNECT_TCP;
    ruleset = (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof attr, 0);
  }
  if (ruleset < 0) CAMLreturn(Val_int(fail_stage(ST_LANDLOCK)));
  int snap_fd = open(snap, O_PATH | O_CLOEXEC | O_DIRECTORY);
  int work_fd = open(work, O_PATH | O_CLOEXEC | O_DIRECTORY);
  if (snap_fd < 0 || work_fd < 0) {
    int saved = errno;
    if (snap_fd >= 0) close(snap_fd);
    if (work_fd >= 0) close(work_fd);
    close(ruleset);
    errno = saved;
    CAMLreturn(Val_int(fail_stage(ST_LANDLOCK)));
  }
  uint64_t read_exec = LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR;
  uint64_t write_work = read_exec | LL_FS_WRITE_FILE | LL_FS_REMOVE_DIR | LL_FS_REMOVE_FILE | LL_FS_MAKE_DIR | LL_FS_MAKE_REG
                        | LL_FS_TRUNCATE | LL_FS_REFER;
  int added = ll_add(ruleset, snap_fd, read_exec);
  if (added == 0) added = ll_add(ruleset, work_fd, write_work);
  close(snap_fd);
  close(work_fd);
  if (added != 0) {
    int saved = errno;
    close(ruleset);
    errno = saved;
    CAMLreturn(Val_int(fail_stage(ST_LANDLOCK)));
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    int saved = errno;
    close(ruleset);
    errno = saved;
    CAMLreturn(Val_int(fail_stage(ST_LANDLOCK)));
  }
  if (syscall(__NR_landlock_restrict_self, ruleset, 0) != 0) {
    int saved = errno;
    close(ruleset);
    errno = saved;
    CAMLreturn(Val_int(fail_stage(ST_LANDLOCK)));
  }
  close(ruleset);
  CAMLreturn(Val_int(0));
}
