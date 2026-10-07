# CMake toolchain file: build LLVM (the *library*) for wasm32-wasip1.
#
# This is the artifact Crystal's compiler needs. Crystal only ever emits
# wasm32-unknown-wasi (it has no Emscripten target), so the libLLVM the compiler
# links must itself be wasm32-wasi -- not Emscripten, not native.
#
# Used by build.sh stage B (`cmake -S llvm -B build-wasi`). Stage A builds the
# host `llvm-tblgen` natively; its path is passed as -DLLVM_TABLEGEN.
#
# WASI_SDK must point at an extracted wasi-sdk (33.0 verified).

cmake_minimum_required(VERSION 3.20)

if(NOT DEFINED WASI_SDK)
  set(WASI_SDK "/opt/wasi-sdk-33")
endif()

set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

set(CMAKE_C_COMPILER   "${WASI_SDK}/bin/clang")
set(CMAKE_CXX_COMPILER "${WASI_SDK}/bin/clang++")
set(CMAKE_AR           "${WASI_SDK}/bin/llvm-ar")
set(CMAKE_RANLIB       "${WASI_SDK}/bin/llvm-ranlib")
set(CMAKE_STRIP        "${WASI_SDK}/bin/llvm-strip")

# wasi-sdk 33's clang defaults to wasm32-unknown-wasip1; be explicit anyway.
set(CMAKE_C_COMPILER_TARGET   wasm32-wasip1)
set(CMAKE_CXX_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_SYSROOT "${WASI_SDK}/share/wasi-sysroot")

# wasi-libc gates <signal.h>, <sys/mman.h> and a few process calls behind
# opt-in macros -- the headers refuse to compile without them. LLVM's support
# layer needs the declarations; the matching libwasi-emulated-*.a files supply
# no-op implementations at link time (see verify/run-probe.sh). They are
# emulation in name only: there are no real signals on WASI, so the parts of
# LLVM that would install handlers simply never fire.
set(WASI_EMULATED
  "-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_PROCESS_CLOCKS")
set(CMAKE_C_FLAGS_INIT "${WASI_EMULATED}")
set(CMAKE_CXX_FLAGS_INIT "${WASI_EMULATED}")

# LLVM archives are huge; make sure the compiler can find the sysroot without a
# driver wrapper, and never pick up the host's libs/headers by accident.
set(CMAKE_FIND_ROOT_PATH "${CMAKE_SYSROOT}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
