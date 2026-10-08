/* compat.c -- definitions for the declarations in wasi-compat.h.
 *
 * WASI preview 1 has no processes, no signals and no user database, so every
 * one of these is a stub that reports failure (or, for the sigset helpers,
 * succeeds trivially). They exist so that a program linking the wasm libLLVM
 * resolves its symbols; none of them can do real work here.
 *
 * Build (see build.sh / verify/run-probe.sh):
 *   clang --target=wasm32-wasip1 --sysroot=... -D_WASI_EMULATED_SIGNAL \
 *     -D_WASI_EMULATED_PROCESS_CLOCKS -I include -include wasi-compat.h \
 *     -c compat.c -o compat.o
 * and link the object into anything that links libLLVM.
 */
#include <dlfcn.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/types.h>

#include "wasi-compat.h"

pid_t fork(void) { return (pid_t)-1; }
int execv(const char *path, char *const argv[]) {
	(void)path; (void)argv;
	return -1;
}
int execve(const char *path, char *const argv[], char *const envp[]) {
	(void)path; (void)argv; (void)envp;
	return -1;
}
pid_t wait(int *status) { (void)status; return (pid_t)-1; }
pid_t waitpid(pid_t pid, int *status, int options) {
	(void)pid; (void)status; (void)options;
	return (pid_t)-1;
}
pid_t wait4(pid_t pid, int *status, int options, struct rusage *usage) {
	(void)pid; (void)status; (void)options; (void)usage;
	return (pid_t)-1;
}
pid_t setsid(void) { return (pid_t)-1; }
int dup2(int oldfd, int newfd) { (void)oldfd; (void)newfd; return -1; }

int kill(pid_t pid, int sig) { (void)pid; (void)sig; return -1; }
unsigned alarm(unsigned seconds) { (void)seconds; return 0; }
int sigaction(int signum, const struct sigaction *act, struct sigaction *oldact) {
	(void)signum; (void)act; (void)oldact;
	return -1;
}
int sigemptyset(sigset_t *set) {
	if (set) memset(set, 0, sizeof *set);
	return 0;
}
int sigfillset(sigset_t *set) {
	if (set) memset(set, 0xff, sizeof *set);
	return 0;
}
int sigaddset(sigset_t *set, int signum) { (void)set; (void)signum; return 0; }
int sigprocmask(int how, const sigset_t *set, sigset_t *oldset) {
	(void)how; (void)set; (void)oldset;
	return 0;
}

int getrlimit(int resource, struct rlimit *rlim) {
	(void)resource;
	if (rlim) {
		rlim->rlim_cur = RLIM_INFINITY;
		rlim->rlim_max = RLIM_INFINITY;
	}
	return 0;
}
int setrlimit(int resource, const struct rlimit *rlim) {
	(void)resource; (void)rlim;
	return 0;
}

struct passwd *getpwuid(uid_t uid) { (void)uid; return 0; }

int dladdr(const void *addr, Dl_info *info) {
	(void)addr;
	if (info) memset(info, 0, sizeof *info);
	return 0;
}

int fchown(int fd, uid_t owner, gid_t group) {
	(void)fd; (void)owner; (void)group;
	return -1;
}
uid_t getuid(void) { return 0; }
int getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen,
               struct passwd **result) {
	(void)uid; (void)pwd; (void)buf; (void)buflen;
	if (result) *result = 0;
	return 0;
}
int getpwnam_r(const char *name, struct passwd *pwd, char *buf, size_t buflen,
               struct passwd **result) {
	(void)name; (void)pwd; (void)buf; (void)buflen;
	if (result) *result = 0;
	return 0;
}
mode_t umask(mode_t mask) { (void)mask; return 0; }

/* WASI's <sys/mman.h> declares posix_madvise under _WASI_EMULATED_MMAN, but
 * libwasi-emulated-mman does not define it (only mmap/munmap/mprotect). It
 * returns 0 for success, like the POSIX call. */
int posix_madvise(void *addr, size_t len, int advice) {
	(void)addr; (void)len; (void)advice;
	return 0;
}

/* <dlfcn.h> declares these on WASI, but libdl.a there is an empty stub, so
 * anything that pulls in LLVM's DynamicLibrary.cpp (the Crystal compiler does)
 * fails to link. There is no dynamic loading on WASI; report failure. */
void *dlopen(const char *filename, int flags) {
	(void)filename; (void)flags;
	return 0;
}
void *dlsym(void *handle, const char *symbol) {
	(void)handle; (void)symbol;
	return 0;
}
int dlclose(void *handle) { (void)handle; return -1; }
char *dlerror(void) { return 0; }
