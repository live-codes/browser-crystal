# The toolchain that turns a .cr file into a browser-runnable .wasm.
#
# Crystal cross-compiles to wasm32-unknown-wasi — but the cross-compile stops at
# the object file: the compiler shells out to wasm-ld and expects a WASI sysroot,
# and the official image ships neither. So wasm-ld and the sysroot come from
# wasi-sdk, pinned below.
#
# Crystal is pinned to 1.17.0 on purpose. The wasm target is broken in 1.21.0,
# the current release: the compiler's own stdlib fails to build for wasm
# (`Crystal::EventLoop::Wasi` does not implement a method the base class
# declares). See FINDINGS.md.
FROM crystallang/crystal:1.17.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*

ARG WASI_SDK_VERSION=22
RUN curl -fsSL -o /tmp/wasi-sdk.tar.gz \
      "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION}.0-linux.tar.gz" \
 && tar -xzf /tmp/wasi-sdk.tar.gz -C /opt \
 && rm /tmp/wasi-sdk.tar.gz

ENV WASI_SDK=/opt/wasi-sdk-22.0
ENV PATH="/opt/wasi-sdk-22.0/bin:${PATH}"

# Crystal's `Regex` is a binding to PCRE2, so a program that uses it asks the
# linker for -lpcre2-8 — which has to be a wasm build, like everything else here.
# Nothing in the official image provides one, so it is built from source against
# the same sysroot the Crystal objects link against.
#
# Only the 8-bit library is built. The default `make` target also builds
# pcre2test, which uses getrlimit and cannot compile for WASI — and is of no use
# to us anyway.
ARG PCRE2_VERSION=10.42
RUN curl -fsSL -o /tmp/pcre2.tar.gz \
      "https://github.com/PCRE2Project/pcre2/releases/download/pcre2-${PCRE2_VERSION}/pcre2-${PCRE2_VERSION}.tar.gz" \
 && tar -xzf /tmp/pcre2.tar.gz -C /tmp \
 && cd /tmp/pcre2-${PCRE2_VERSION} \
 && ./configure \
      --host=wasm32-wasi \
      --disable-shared \
      --enable-static \
      --disable-pcre2grep-callout \
      --prefix=/opt/pcre2-wasm \
      CC="clang --target=wasm32-wasi --sysroot=${WASI_SDK}/share/wasi-sysroot" \
      CFLAGS="-O2" \
 && make -j"$(nproc)" libpcre2-8.la \
 && mkdir -p /opt/pcre2-wasm/lib /opt/pcre2-wasm/include \
 && cp .libs/libpcre2-8.a /opt/pcre2-wasm/lib/ \
 && cp src/pcre2.h /opt/pcre2-wasm/include/ \
 && rm -rf /tmp/pcre2-${PCRE2_VERSION} /tmp/pcre2.tar.gz

ENV PCRE2_LIB=/opt/pcre2-wasm/lib
