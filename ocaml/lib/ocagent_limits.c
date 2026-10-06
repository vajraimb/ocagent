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
#include <sys/socket.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <setjmp.h>
#include <time.h>
#include <unistd.h>

#define ST_NAMESPACE 3
#define ST_UID 4
#define ST_GID 5
#define ST_MOUNT 6
#define ST_CHROOT 7
#define ST_CHDIR 8
#define ST_LANDLOCK 9
#define ST_SETGROUPS 10
#define ST_PROPAGATION 11
#define ST_JAIL_MKDIR 12
#define ST_JAIL_TMPFS 13
#define ST_SNAPSHOT_BIND 14
#define ST_SNAPSHOT_RO 15
#define ST_WORK_BIND 16
#define ST_ROOT_MOVE 17

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

value ocagent_close_extra_fds(value keep_a, value keep_b, value keep_c) {
  int keep0 = Int_val(keep_a);
  int keep1 = Int_val(keep_b);
  int keep2 = Int_val(keep_c);
  DIR *dir = opendir("/proc/self/fd");
  if (dir == NULL) return Val_int(-errno);
  int self = dirfd(dir);
  struct dirent *ent;
  while ((ent = readdir(dir)) != NULL) {
    char *end = NULL;
    long fd = strtol(ent->d_name, &end, 10);
    if (end == ent->d_name || *end != '\0') continue;
    if (fd > 2 && fd != self && fd != keep0 && fd != keep1 && fd != keep2) close((int)fd);
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

static int stage_errno(int stage) { return stage * 1000 + errno; }

static int bind_tree(const char *jail, const char *src) {
  struct stat st;
  char dst[4096];
  if (stat(src, &st) != 0) return -1;
  if (!S_ISDIR(st.st_mode)) {
    errno = ENOTDIR;
    return -1;
  }
  if (snprintf(dst, sizeof dst, "%s%s", jail, src) >= (int)sizeof dst) {
    errno = ENAMETOOLONG;
    return -1;
  }
  mkdir_p(dst);
  if (mount(src, dst, NULL, MS_BIND | MS_REC, NULL) != 0) return -1;
  return 0;
}

static int remount_readonly(const char *jail, const char *src) {
  char dst[4096];
  if (snprintf(dst, sizeof dst, "%s%s", jail, src) >= (int)sizeof dst) {
    errno = ENAMETOOLONG;
    return -1;
  }
  if (mount(NULL, dst, NULL, MS_REMOUNT | MS_BIND | MS_RDONLY, NULL) != 0) return -1;
  return 0;
}

value ocagent_mount_jail(value v_work, value v_snap) {
  CAMLparam2(v_work, v_snap);
  char work[4096], snap[4096], jail[128];
  if (copy_path(v_work, work, sizeof work)) CAMLreturn(Val_int(ST_WORK_BIND * 1000 + ENAMETOOLONG));
  if (copy_path(v_snap, snap, sizeof snap)) CAMLreturn(Val_int(ST_SNAPSHOT_BIND * 1000 + ENAMETOOLONG));
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) CAMLreturn(Val_int(stage_errno(ST_PROPAGATION)));
  snprintf(jail, sizeof jail, "/tmp/ocagent-jail-%d", getpid());
  if (mkdir(jail, 0700) != 0 && errno != EEXIST) CAMLreturn(Val_int(stage_errno(ST_JAIL_MKDIR)));
  if (mount("tmpfs", jail, "tmpfs", 0, "size=64m") != 0) CAMLreturn(Val_int(stage_errno(ST_JAIL_TMPFS)));
  if (bind_tree(jail, snap) != 0) CAMLreturn(Val_int(stage_errno(ST_SNAPSHOT_BIND)));
  if (remount_readonly(jail, snap) != 0) CAMLreturn(Val_int(stage_errno(ST_SNAPSHOT_RO)));
  if (bind_tree(jail, work) != 0) CAMLreturn(Val_int(stage_errno(ST_WORK_BIND)));
  if (chdir(jail) != 0) CAMLreturn(Val_int(stage_errno(ST_CHDIR)));
  if (mount(".", "/", NULL, MS_MOVE, NULL) != 0) CAMLreturn(Val_int(stage_errno(ST_ROOT_MOVE)));
  if (chroot(".") != 0) CAMLreturn(Val_int(stage_errno(ST_CHROOT)));
  if (chdir("/") != 0) CAMLreturn(Val_int(stage_errno(ST_CHDIR)));
  CAMLreturn(Val_int(0));
}

value ocagent_clearenv(value unit) {
  (void)unit;
  clearenv();
  return Val_unit;
}

value ocagent_unshare_user(value unit) {
  (void)unit;
  if (unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWNET) != 0) return Val_int(fail_stage(ST_NAMESPACE));
  return Val_int(0);
}

value ocagent_write_maps(value v_pid) {
  int pid = Int_val(v_pid);
  char path[128], map[64];
  uid_t uid = getuid();
  gid_t gid = getgid();
  snprintf(path, sizeof path, "/proc/%d/setgroups", pid);
  if (write_text(path, "deny\n") != 0) return Val_int(ST_SETGROUPS * 1000 + errno);
  snprintf(path, sizeof path, "/proc/%d/uid_map", pid);
  snprintf(map, sizeof map, "0 %u 1\n", (unsigned)uid);
  if (write_text(path, map) != 0) return Val_int(ST_UID * 1000 + errno);
  snprintf(path, sizeof path, "/proc/%d/gid_map", pid);
  snprintf(map, sizeof map, "0 %u 1\n", (unsigned)gid);
  if (write_text(path, map) != 0) return Val_int(ST_GID * 1000 + errno);
  return Val_int(0);
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
    if (ruleset < 0) CAMLreturn(Val_int(fail_stage(ST_LANDLOCK)));
  } else {
    struct ll_attr4 attr;
    memset(&attr, 0, sizeof attr);
    attr.handled_access_fs = fs;
    attr.handled_access_net = LL_NET_BIND_TCP | LL_NET_CONNECT_TCP;
    ruleset = (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof attr, 0);
    if (ruleset < 0) CAMLreturn(Val_int(fail_stage(ST_LANDLOCK)));
  }
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

#define ST_ARTIFACT_BIND 18
#define ST_ARTIFACT_RO 19
#define ST_SECCOMP 21
#define ST_PDEATH 22

value ocagent_mount_worker(value v_snap, value v_art) {
  CAMLparam2(v_snap, v_art);
  char snap[4096], art[4096], jail[128], tmp[160];
  if (copy_path(v_snap, snap, sizeof snap)) CAMLreturn(Val_int(ST_SNAPSHOT_BIND * 1000 + ENAMETOOLONG));
  if (copy_path(v_art, art, sizeof art)) CAMLreturn(Val_int(ST_ARTIFACT_BIND * 1000 + ENAMETOOLONG));
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) CAMLreturn(Val_int(stage_errno(ST_PROPAGATION)));
  snprintf(jail, sizeof jail, "/tmp/ocagent-wjail-%d", getpid());
  if (mkdir(jail, 0700) != 0 && errno != EEXIST) CAMLreturn(Val_int(stage_errno(ST_JAIL_MKDIR)));
  if (mount("tmpfs", jail, "tmpfs", 0, "size=8m,mode=755") != 0) CAMLreturn(Val_int(stage_errno(ST_JAIL_TMPFS)));
  if (bind_tree(jail, snap) != 0) CAMLreturn(Val_int(stage_errno(ST_SNAPSHOT_BIND)));
  if (remount_readonly(jail, snap) != 0) CAMLreturn(Val_int(stage_errno(ST_SNAPSHOT_RO)));
  if (bind_tree(jail, art) != 0) CAMLreturn(Val_int(stage_errno(ST_ARTIFACT_BIND)));
  if (remount_readonly(jail, art) != 0) CAMLreturn(Val_int(stage_errno(ST_ARTIFACT_RO)));
  char devdir[160], devnull[180], devrand[180];
  if (snprintf(devdir, sizeof devdir, "%s/dev", jail) >= (int)sizeof devdir) CAMLreturn(Val_int(ST_JAIL_MKDIR * 1000 + ENAMETOOLONG));
  if (mkdir(devdir, 0755) != 0 && errno != EEXIST) CAMLreturn(Val_int(stage_errno(ST_JAIL_MKDIR)));
  if (snprintf(devnull, sizeof devnull, "%s/null", devdir) >= (int)sizeof devnull) CAMLreturn(Val_int(ST_JAIL_MKDIR * 1000 + ENAMETOOLONG));
  if (snprintf(devrand, sizeof devrand, "%s/urandom", devdir) >= (int)sizeof devrand) CAMLreturn(Val_int(ST_JAIL_MKDIR * 1000 + ENAMETOOLONG));
  int dev_fd = open(devnull, O_CREAT | O_WRONLY, 0666);
  if (dev_fd < 0) CAMLreturn(Val_int(stage_errno(ST_JAIL_MKDIR)));
  close(dev_fd);
  dev_fd = open(devrand, O_CREAT | O_WRONLY, 0666);
  if (dev_fd < 0) CAMLreturn(Val_int(stage_errno(ST_JAIL_MKDIR)));
  close(dev_fd);
  if (mount("/dev/null", devnull, NULL, MS_BIND, NULL) != 0) CAMLreturn(Val_int(stage_errno(ST_JAIL_TMPFS)));
  if (mount("/dev/urandom", devrand, NULL, MS_BIND, NULL) != 0) CAMLreturn(Val_int(stage_errno(ST_JAIL_TMPFS)));
  if (snprintf(tmp, sizeof tmp, "%s/tmp", jail) >= (int)sizeof tmp) CAMLreturn(Val_int(ST_JAIL_MKDIR * 1000 + ENAMETOOLONG));
  if (mkdir(tmp, 0700) != 0 && errno != EEXIST) CAMLreturn(Val_int(stage_errno(ST_JAIL_MKDIR)));
  if (chdir(jail) != 0) CAMLreturn(Val_int(stage_errno(ST_CHDIR)));
  if (mount(".", "/", NULL, MS_MOVE, NULL) != 0) CAMLreturn(Val_int(stage_errno(ST_ROOT_MOVE)));
  if (chroot(".") != 0) CAMLreturn(Val_int(stage_errno(ST_CHROOT)));
  if (chdir("/tmp") != 0) CAMLreturn(Val_int(stage_errno(ST_CHDIR)));
  CAMLreturn(Val_int(0));
}

value ocagent_limit_worker(value as_bytes, value file_bytes) {
  struct rlimit limit;
  limit.rlim_cur = Long_val(as_bytes);
  limit.rlim_max = Long_val(as_bytes);
  if (setrlimit(RLIMIT_AS, &limit) != 0) return Val_int(-errno);
  limit.rlim_cur = Long_val(file_bytes);
  limit.rlim_max = Long_val(file_bytes);
  if (setrlimit(RLIMIT_FSIZE, &limit) != 0) return Val_int(-errno);
  limit.rlim_cur = 20;
  limit.rlim_max = 20;
  if (setrlimit(RLIMIT_CPU, &limit) != 0) return Val_int(-errno);
  return Val_int(0);
}

value ocagent_setpgid(value pid) {
  pid_t p = Int_val(pid);
  if (p == 0) p = getpid();
  if (setpgid(p, p) != 0) return Val_int(-errno);
  return Val_int(0);
}

value ocagent_monotonic(value unit) {
  CAMLparam1(unit);
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) caml_failwith("monotonic");
  CAMLreturn(caml_copy_double((double)ts.tv_sec + (double)ts.tv_nsec / 1e9));
}

value ocagent_set_subreaper(value unit) {
  (void)unit;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) return Val_int(-errno);
  return Val_int(0);
}

value ocagent_arm_pdeath(value unit) {
  (void)unit;
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0, 0) != 0) return Val_int(-errno);
  if (getppid() == 1) return Val_int(-ECHILD);
  return Val_int(0);
}

/* x32 shares AUDIT_ARCH_X86_64; bit 30 in nr identifies its syscall space. */
#ifndef __X32_SYSCALL_BIT
#define __X32_SYSCALL_BIT 0x40000000
#endif

#define SECCOMP_FILTER_MAX 26

static int seccomp_filter_fill(struct sock_filter *filter) {
  /* Only the native x86-64 ABI reaches the allow rules. i386 and x32 are
     rejected with EPERM, so a compatibility fork cannot skip the native deny.
     clone is allowed only with CLONE_THREAD. prctl is denied so PDEATHSIG
     cannot be cleared. Reject x32 before comparing native syscall numbers. */
  struct sock_filter tmp[] = {
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, __X32_SYSCALL_BIT, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_setsid, 16, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_setpgid, 15, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_setns, 14, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_unshare, 13, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_mount, 12, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_umount2, 11, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_pivot_root, 10, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_chroot, 9, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_fork, 8, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_vfork, 7, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 6, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prctl, 5, 0),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
      BPF_STMT(BPF_ALU | BPF_AND | BPF_K, 0x00010000),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x00010000, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  memcpy(filter, tmp, sizeof tmp);
  return (int)(sizeof tmp / sizeof tmp[0]);
}

static uint32_t seccomp_eval(const struct sock_filter *filter, int len, const struct seccomp_data *data) {
  uint32_t acc = 0;
  int pc = 0;
  while (pc >= 0 && pc < len) {
    struct sock_filter insn = filter[pc];
    if (insn.code == (BPF_LD | BPF_W | BPF_ABS)) {
      if (insn.k > sizeof *data - 4) return SECCOMP_RET_KILL_THREAD;
      memcpy(&acc, (const char *)data + insn.k, 4);
      pc++;
    } else if (insn.code == (BPF_JMP | BPF_JEQ | BPF_K)) {
      pc += 1 + (acc == insn.k ? insn.jt : insn.jf);
    } else if (insn.code == (BPF_JMP | BPF_JSET | BPF_K)) {
      pc += 1 + ((acc & insn.k) ? insn.jt : insn.jf);
    } else if (insn.code == (BPF_ALU | BPF_AND | BPF_K)) {
      acc &= insn.k;
      pc++;
    } else if (insn.code == (BPF_RET | BPF_K)) {
      return insn.k;
    } else {
      return SECCOMP_RET_KILL_THREAD;
    }
  }
  return SECCOMP_RET_KILL_THREAD;
}

static int seccomp_errno_of(uint32_t decision) {
  if ((decision & SECCOMP_RET_ACTION_FULL) != SECCOMP_RET_ERRNO) return -1;
  return (int)(decision & SECCOMP_RET_DATA);
}

/* The installed program, not a second policy. i386 and x32 numbers must be
   EPERM. Native process, session, and namespace calls must be EPERM. A native
   read, and clone with CLONE_THREAD, must be allowed. */
static int seccomp_policy_holds(void) {
  struct sock_filter filter[SECCOMP_FILTER_MAX];
  int len = seccomp_filter_fill(filter);
  struct seccomp_data data;
  memset(&data, 0, sizeof data);
  data.arch = AUDIT_ARCH_I386;
  data.nr = 2;
  if (seccomp_errno_of(seccomp_eval(filter, len, &data)) != EPERM) return 0;
  data.arch = AUDIT_ARCH_X86_64;
  int x32[] = { __NR_read, __NR_fork, __NR_vfork, __NR_prctl, __NR_clone };
  for (unsigned i = 0; i < sizeof x32 / sizeof x32[0]; i++) {
    data.nr = __X32_SYSCALL_BIT | x32[i];
    data.args[0] = 0;
    if (seccomp_errno_of(seccomp_eval(filter, len, &data)) != EPERM) return 0;
    data.args[0] = CLONE_THREAD;
    if (seccomp_errno_of(seccomp_eval(filter, len, &data)) != EPERM) return 0;
  }
  int denied[] = { __NR_fork, __NR_vfork, __NR_clone3, __NR_setsid, __NR_setpgid, __NR_prctl, __NR_unshare, __NR_mount };
  for (unsigned i = 0; i < sizeof denied / sizeof denied[0]; i++) {
    data.nr = denied[i];
    data.args[0] = 0;
    if (seccomp_errno_of(seccomp_eval(filter, len, &data)) != EPERM) return 0;
  }
  data.nr = __NR_read;
  if (seccomp_eval(filter, len, &data) != SECCOMP_RET_ALLOW) return 0;
  data.nr = __NR_clone;
  data.args[0] = 0;
  if (seccomp_errno_of(seccomp_eval(filter, len, &data)) != EPERM) return 0;
  data.args[0] = 0x00010000ULL;
  if (seccomp_eval(filter, len, &data) != SECCOMP_RET_ALLOW) return 0;
  return 1;
}

static int seccomp_install(void) {
  struct sock_filter filter[SECCOMP_FILTER_MAX];
  int len = seccomp_filter_fill(filter);
  struct sock_fprog prog = { .len = (unsigned short)len, .filter = filter };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) return -1;
  return 0;
}

value ocagent_confine_worker(value unit) {
  (void)unit;
  if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) return Val_int(ST_PDEATH * 1000 + errno);
  if (getppid() == 1) return Val_int(ST_PDEATH * 1000 + ECHILD);
  if (seccomp_install() != 0) return Val_int(ST_SECCOMP * 1000 + errno);
  return Val_int(0);
}

static volatile sig_atomic_t compat_sig;
static sigjmp_buf compat_jmp;

static void compat_fault(int sig) {
  compat_sig = sig;
  siglongjmp(compat_jmp, 1);
}

value ocagent_worker_probe(value v_art, value v_sentinel, value v_store, value v_port) {
  CAMLparam4(v_art, v_sentinel, v_store, v_port);
  char art[4096], sentinel[4096], store[4096];
  int port = Int_val(v_port);
  if (copy_path(v_art, art, sizeof art) || copy_path(v_sentinel, sentinel, sizeof sentinel) || copy_path(v_store, store, sizeof store))
    caml_failwith("probe path");
  int setsid_err = 0, setpgid_err = 0, fork_err = 0, vfork_err = 0, clone3_err = 0, unshare_err = 0;
  int compat_err = 0, compat_entered = 0, mount_err = 0, prctl_err = 0;
  int tcp = 0, stat_ok = 0, store_ok = 0, tmp_ok = 0, ro_ok = 0;
  int policy = seccomp_policy_holds();
  if (setsid() < 0) setsid_err = errno;
  if (setpgid(0, 0) < 0) setpgid_err = errno;
  if (prctl(PR_SET_PDEATHSIG, 0, 0, 0, 0) != 0) prctl_err = errno;
  pid_t child = fork();
  if (child < 0) fork_err = errno;
  else if (child == 0) _exit(0);
  else {
    int st = 0;
    waitpid(child, &st, 0);
  }
  long vfork_ret = syscall(__NR_vfork);
  if (vfork_ret < 0) vfork_err = errno;
  else if (vfork_ret == 0) _exit(0);
  else {
    int st = 0;
    waitpid((pid_t)vfork_ret, &st, 0);
  }
  long clone3_ret = syscall(__NR_clone3, NULL, (size_t)0);
  if (clone3_ret < 0) clone3_err = errno;
  else if (clone3_ret == 0) _exit(0);
  else {
    int st = 0;
    waitpid((pid_t)clone3_ret, &st, 0);
  }
  if (syscall(__NR_unshare, CLONE_NEWNS) != 0) unshare_err = errno;
#if defined(__x86_64__)
  {
    /* A kernel without CONFIG_IA32_EMULATION raises SIGSEGV on int $0x80
       before seccomp. That is not a filter denial: leave compat_entered=0.
       A kernel that enters the compat syscall must return EPERM, never a pid. */
    struct sigaction saved_segv, saved_sys, action;
    compat_sig = 0;
    memset(&action, 0, sizeof action);
    action.sa_handler = compat_fault;
    sigemptyset(&action.sa_mask);
    sigaction(SIGSEGV, &action, &saved_segv);
    sigaction(SIGSYS, &action, &saved_sys);
    if (sigsetjmp(compat_jmp, 1) == 0) {
      long cret;
      asm volatile("movl $2, %%eax\n\t"
                   "int $0x80\n\t"
                   : "=a"(cret)
                   :
                   : "ebx", "ecx", "edx", "esi", "edi", "memory", "cc");
      compat_entered = 1;
      if (cret < 0) compat_err = (int)(-cret);
      else if (cret == 0) _exit(0);
      else {
        int st = 0;
        waitpid((pid_t)cret, &st, 0);
        compat_err = 0;
      }
    } else if (compat_sig == SIGSEGV) {
      compat_entered = 0;
      compat_err = 0;
    } else {
      compat_entered = 1;
      compat_err = 0;
    }
    sigaction(SIGSEGV, &saved_segv, NULL);
    sigaction(SIGSYS, &saved_sys, NULL);
  }
#else
  compat_entered = 0;
  compat_err = ENOSYS;
#endif
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) mount_err = errno;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd >= 0) {
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    addr.sin_addr.s_addr = htonl(0x7f000001);
    if (connect(fd, (struct sockaddr *)&addr, sizeof addr) == 0) tcp = 1;
    close(fd);
  }
  struct stat st;
  if (stat(sentinel, &st) == 0) stat_ok = 1;
  if (stat(store, &st) == 0) store_ok = 1;
  int out = open("/tmp/ocagent-probe", O_CREAT | O_EXCL | O_WRONLY, 0600);
  if (out >= 0) {
    if (write(out, "x", 1) == 1) tmp_ok = 1;
    close(out);
  }
  int rw = open(art, O_WRONLY);
  if (rw >= 0) {
    ro_ok = 1;
    close(rw);
  }
  char line[512];
  snprintf(line, sizeof line,
           "setsid=%d setpgid=%d fork=%d vfork=%d clone3=%d unshare=%d compat=%d entered=%d policy=%d mount=%d prctl=%d tcp=%d stat=%d store=%d tmp=%d ro=%d",
           setsid_err, setpgid_err, fork_err, vfork_err, clone3_err, unshare_err, compat_err, compat_entered, policy, mount_err, prctl_err, tcp, stat_ok, store_ok, tmp_ok, ro_ok);
  CAMLreturn(caml_copy_string(line));
}
