/* wasi-compat.h -- force-included into every LLVM translation unit for WASI.
 *
 * LLVM's Unix support layer uses POSIX facilities that wasi-libc does not
 * declare at all. This header supplies the *declarations* so the code compiles;
 * wasi-compat/compat.c supplies *definitions* so it links. On WASI the
 * definitions are honest stubs -- there are no processes, signals or users, so
 * fork() cannot succeed and sigaction() registers nothing. The Crystal compiler
 * never calls these; LLVM's support library still has to define them.
 *
 * Note what is deliberately NOT here: getrusage, signal() and raise() come from
 * wasi-libc's emulated libraries and are declared by the sysroot already.
 * Turning on __wasilibc_unmodified_upstream instead would pull in all of musl's
 * bits/ headers, which wasi-libc does not ship -- that is why this is explicit.
 *
 * Every block is guarded, so this is inert if the SDK ever supplies the names.
 */
#ifndef WASI_COMPAT_H
#define WASI_COMPAT_H

#include <stddef.h>
#include <sys/types.h>

/* ---------- sigset_t / signal sets ---------- */
#ifndef __DEFINED_sigset_t
#define __DEFINED_sigset_t
typedef struct __sigset_t { unsigned long __bits[128 / sizeof(long)]; } sigset_t;
#endif

#ifndef SIG_BLOCK
#define SIG_BLOCK 0
#endif
#ifndef SIG_UNBLOCK
#define SIG_UNBLOCK 1
#endif
#ifndef SIG_SETMASK
#define SIG_SETMASK 2
#endif

/* ---------- sigaction ---------- */
#ifndef __DEFINED_siginfo_t
#define __DEFINED_siginfo_t
typedef struct siginfo_t {
	int si_signo;
	int si_errno;
	int si_code;
	long __pad[8];
} siginfo_t;
#endif

#ifndef WASI_COMPAT_SIGACTION
#define WASI_COMPAT_SIGACTION
struct sigaction {
	void (*sa_handler)(int);
	sigset_t sa_mask;
	int sa_flags;
	void (*sa_sigaction)(int, siginfo_t *, void *);
	void (*sa_restorer)(void);
};
#endif

#ifndef SA_NOCLDSTOP
#define SA_NOCLDSTOP 1
#endif
#ifndef SA_NOCLDWAIT
#define SA_NOCLDWAIT 2
#endif
#ifndef SA_SIGINFO
#define SA_SIGINFO 4
#endif
#ifndef SA_RESTORER
#define SA_RESTORER 0x04000000
#endif
#ifndef SA_ONSTACK
#define SA_ONSTACK 0x08000000
#endif
#ifndef SA_RESTART
#define SA_RESTART 0x10000000
#endif
#ifndef SA_NODEFER
#define SA_NODEFER 0x40000000
#endif
#ifndef SA_RESETHAND
#define SA_RESETHAND 0x80000000
#endif

int sigemptyset(sigset_t *set);
int sigfillset(sigset_t *set);
int sigaddset(sigset_t *set, int signum);
int sigprocmask(int how, const sigset_t *set, sigset_t *oldset);
int sigaction(int signum, const struct sigaction *act, struct sigaction *oldact);
int kill(pid_t pid, int sig);
unsigned alarm(unsigned seconds);

/* ---------- rlimit (sys/resource.h ships rusage/getrusage, not rlimit) ---------- */
#ifndef WASI_COMPAT_RLIMIT
#define WASI_COMPAT_RLIMIT
typedef unsigned long long rlim_t;
struct rlimit {
	rlim_t rlim_cur;
	rlim_t rlim_max;
};
#endif
#ifndef RLIMIT_CPU
#define RLIMIT_CPU 0
#endif
#ifndef RLIMIT_FSIZE
#define RLIMIT_FSIZE 1
#endif
#ifndef RLIMIT_DATA
#define RLIMIT_DATA 2
#endif
#ifndef RLIMIT_STACK
#define RLIMIT_STACK 3
#endif
#ifndef RLIMIT_CORE
#define RLIMIT_CORE 4
#endif
#ifndef RLIMIT_NOFILE
#define RLIMIT_NOFILE 7
#endif
#ifndef RLIMIT_AS
#define RLIMIT_AS 9
#endif
#ifndef RLIM_INFINITY
#define RLIM_INFINITY (~(rlim_t)0)
#endif
struct rusage;
int getrlimit(int resource, struct rlimit *rlim);
int setrlimit(int resource, const struct rlimit *rlim);

/* ---------- <sys/wait.h>: WASI has no such header ---------- */
#ifndef WNOHANG
#define WNOHANG 1
#endif
#ifndef WUNTRACED
#define WUNTRACED 2
#endif
#ifndef WCONTINUED
#define WCONTINUED 8
#endif
#ifndef WEXITSTATUS
#define WEXITSTATUS(s) (((s) & 0xff00) >> 8)
#endif
#ifndef WTERMSIG
#define WTERMSIG(s) ((s) & 0x7f)
#endif
#ifndef WIFEXITED
#define WIFEXITED(s) (!WTERMSIG(s))
#endif
#ifndef WIFSTOPPED
#define WIFSTOPPED(s) (((s) & 0xff) == 0x7f)
#endif
#ifndef WIFSIGNALED
#define WIFSIGNALED(s) (((signed char)(((s) & 0x7f) + 1) >> 1) > 0)
#endif
#ifndef WCOREDUMP
#define WCOREDUMP(s) ((s) & 0x80)
#endif
pid_t wait(int *status);
pid_t waitpid(pid_t pid, int *status, int options);
pid_t wait4(pid_t pid, int *status, int options, struct rusage *usage);

/* ---------- process creation ---------- */
pid_t fork(void);
int execv(const char *path, char *const argv[]);
int execve(const char *path, char *const argv[], char *const envp[]);
pid_t setsid(void);
int dup2(int oldfd, int newfd);

/* ---------- <pwd.h>: WASI has no user database ---------- */
#ifndef WASI_COMPAT_PWD
#define WASI_COMPAT_PWD
struct passwd {
	char *pw_name;
	char *pw_passwd;
	uid_t pw_uid;
	gid_t pw_gid;
	char *pw_gecos;
	char *pw_dir;
	char *pw_shell;
};
#endif
struct passwd *getpwuid(uid_t uid);

/* ---------- <dlfcn.h>: Dl_info/dladdr are gated upstream, declare here ---------- */
#ifndef WASI_COMPAT_DLINFO
#define WASI_COMPAT_DLINFO
typedef struct {
	const char *dli_fname;
	void *dli_fbase;
	const char *dli_sname;
	void *dli_saddr;
} Dl_info;
#endif
int dladdr(const void *addr, Dl_info *info);

/* ---------- fcntl record locks (Path.inc's lockFile/unlockFile) ----------
 * wasi-libc's <fcntl.h> already defines struct flock; only the lock *commands*
 * are missing, so those are all this supplies. */
#ifndef F_WRLCK
#define F_WRLCK 1
#endif
#ifndef F_UNLCK
#define F_UNLCK 2
#endif
#ifndef F_SETLK
#define F_SETLK 6
#endif
#ifndef F_SETLKW
#define F_SETLKW 7
#endif

/* ---------- ownership / user lookups / umask ---------- */
int fchown(int fd, uid_t owner, gid_t group);
uid_t getuid(void);
int getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen,
               struct passwd **result);
int getpwnam_r(const char *name, struct passwd *pwd, char *buf, size_t buflen,
               struct passwd **result);
mode_t umask(mode_t mask);

#endif /* WASI_COMPAT_H */
