#!/usr/bin/env python3
"""Apply the patches LLVM needs to build for wasm32-wasip1.

Upstream LLVM does not support WASI as a build target, so the cross build needs a
handful of edits. Each is a literal, idempotent replacement rather than a `.patch`
file: the replacements are easy to read, and re-running is a no-op once applied.

    python3 apply-patches.py <llvm-project-src-root>

Each entry is (path relative to the source root, exact old text, replacement).
The script refuses to continue if a target does not contain the old text, so a
toolchain/source bump fails loudly instead of silently skipping a fix.
"""
import pathlib
import sys

WASI_UNIX_OLD = """elseif(FUCHSIA OR UNIX)
  set(LLVM_ON_WIN32 0)
  set(LLVM_ON_UNIX 1)
  if(APPLE OR ${CMAKE_SYSTEM_NAME} MATCHES "AIX")
    set(LLVM_HAVE_LINK_VERSION_SCRIPT 0)"""

WASI_UNIX_NEW = """elseif(FUCHSIA OR UNIX OR CMAKE_SYSTEM_NAME MATCHES "WASI")
  set(LLVM_ON_WIN32 0)
  set(LLVM_ON_UNIX 1)
  if(APPLE OR ${CMAKE_SYSTEM_NAME} MATCHES "AIX" OR CMAKE_SYSTEM_NAME MATCHES "WASI")
    set(LLVM_HAVE_LINK_VERSION_SCRIPT 0)"""

ENDIAN_OLD = "defined(__EMSCRIPTEN__) || defined(__NetBSD__)"
ENDIAN_NEW = "defined(__EMSCRIPTEN__) || defined(__wasi__) || defined(__NetBSD__)"

UNIXH_OLD = "#include <sys/types.h>\n#include <sys/wait.h>"
UNIXH_NEW = """#include <sys/types.h>
// WASI preview 1 has no processes: there is no <sys/wait.h> and no waitpid().
// Program.inc's process-creation code is guarded for __wasi__ below.
#if !defined(__wasi__)
#include <sys/wait.h>
#endif"""

WATCHDOG_OLD = """Watchdog::Watchdog(unsigned int seconds) {
#ifdef HAVE_UNISTD_H
  alarm(seconds);
#endif
}

Watchdog::~Watchdog() {
#ifdef HAVE_UNISTD_H
  alarm(0);
#endif
}"""
WATCHDOG_NEW = """Watchdog::Watchdog(unsigned int seconds) {
#if defined(HAVE_UNISTD_H) && !defined(__wasi__)
  alarm(seconds);
#endif
}

Watchdog::~Watchdog() {
#if defined(HAVE_UNISTD_H) && !defined(__wasi__)
  alarm(0);
#endif
}"""

LOCKFILE_OLD = "#if LLVM_ON_UNIX && !defined(__ANDROID__)"
LOCKFILE_NEW = "#if LLVM_ON_UNIX && !defined(__ANDROID__) && !defined(__wasi__)"

# Path.inc's is_local()/is_remote() ends in a statvfs branch that reads
# MNT_LOCAL and statvfs::f_flags -- neither exists on WASI's statvfs. z/OS
# already takes the conservative "not local" answer; WASI joins it.
MNT_OLD = """#elif defined(__MVS__)
  // The file system can have an arbitrary structure on z/OS; must go with the
  // conservative answer.
  return false;"""
MNT_NEW = """#elif defined(__MVS__) || defined(__wasi__)
  // The file system can have an arbitrary structure on z/OS, and WASI has no
  // mount table at all; both go with the conservative answer.
  return false;"""

# wasi-libc's struct rusage has no ru_maxrss, so Program.inc's peak-memory
# accounting cannot read it. Leave PeakMemory at 0 instead.
RSS_OLD = """#if !defined(__HAIKU__) && !defined(__MVS__)
    PeakMemory = static_cast<uint64_t>(Info.ru_maxrss);
#endif"""
RSS_NEW = """#if !defined(__HAIKU__) && !defined(__MVS__) && !defined(__wasi__)
    PeakMemory = static_cast<uint64_t>(Info.ru_maxrss);
#endif"""

PATCHES = [
    # wasi-libc ships <endian.h> (and <byteswap.h>), but the platform list in
    # ADT/bit.h does not know __wasi__, so it falls through to the generic
    # "include <machine/endian.h>" branch -- a header WASI does not have.
    ("llvm/include/llvm/ADT/bit.h", ENDIAN_OLD, ENDIAN_NEW),
    # Unix.h pulls in <sys/wait.h> unconditionally; WASI has no such header.
    ("llvm/lib/Support/Unix/Unix.h", UNIXH_OLD, UNIXH_NEW),
    # alarm() is a signal-timer call WASI does not have. The watchdog is a
    # no-op on a platform with no signals.
    ("llvm/lib/Support/Unix/Watchdog.inc", WATCHDOG_OLD, WATCHDOG_NEW),
    # LockFileManager probes whether a process is alive with getsid(); there are
    # no processes and no getsid() on WASI. Fall through to "assume alive".
    ("llvm/lib/Support/LockFileManager.cpp", LOCKFILE_OLD, LOCKFILE_NEW),
    # Two files are pure operating-system features that WASI preview 1 does not
    # have at all, and nothing else in the libraries we build references them:
    #   - CrashRecoveryContext.cpp: signal handlers + setjmp/longjmp.
    #   - raw_socket_stream.cpp:   AF_UNIX sockets.
    # Drop them from LLVMSupport on WASI rather than stub a large surface.
    ("llvm/lib/Support/CMakeLists.txt",
     "  CrashRecoveryContext.cpp",
     "  $<$<NOT:$<PLATFORM_ID:WASI>>:CrashRecoveryContext.cpp>"),
    ("llvm/lib/Support/CMakeLists.txt",
     "  raw_socket_stream.cpp",
     "  $<$<NOT:$<PLATFORM_ID:WASI>>:raw_socket_stream.cpp>"),
    # Excluding sources trips LLVM's check that every .cpp in a directory is
    # listed in the target (LLVMProcessSources.cmake). PARTIAL_SOURCES_INTENDED
    # is the documented opt-out for exactly this case.
    ("llvm/lib/Support/CMakeLists.txt",
     "add_llvm_component_library(LLVMSupport",
     "add_llvm_component_library(LLVMSupport PARTIAL_SOURCES_INTENDED"),
    # statvfs / rusage fields WASI's sysroot does not have.
    ("llvm/lib/Support/Unix/Path.inc", MNT_OLD, MNT_NEW),
    ("llvm/lib/Support/Unix/Program.inc", RSS_OLD, RSS_NEW),
    # LLVM classifies platforms as Windows / Unix / Generic and aborts on
    # anything else. A custom CMAKE_SYSTEM_NAME of "WASI" matches none, so the
    # cross configure dies at HandleLLVMOptions.cmake:235 with "Unable to
    # determine platform". WASI is POSIX-shaped (wasi-libc), so it belongs with
    # Unix -- and it gets no linker version scripts, which wasm-ld does not have.
    ("llvm/cmake/modules/HandleLLVMOptions.cmake", WASI_UNIX_OLD, WASI_UNIX_NEW),
]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = pathlib.Path(sys.argv[1])
    if not (root / "llvm/CMakeLists.txt").is_file():
        print(f"not an llvm-project source tree: {root}", file=sys.stderr)
        return 2

    for rel, old, new in PATCHES:
        path = root / rel
        text = path.read_text()
        if new in text:
            print(f"already applied: {rel}")
            continue
        if old not in text:
            print(f"PATCH TARGET CHANGED, cannot apply: {rel}", file=sys.stderr)
            return 1
        path.write_text(text.replace(old, new, 1))
        print(f"patched: {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
