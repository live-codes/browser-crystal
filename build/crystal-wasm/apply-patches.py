#!/usr/bin/env python3
"""Patch the Crystal source so the *compiler* can be built for wasm32-wasi.

    python3 apply-patches.py <crystal-src-root>

Two of the compiler's commands cannot exist in a wasm build:

  * `crystal play` starts an HTTP server -- it needs sockets, which WASI
    preview 1 does not have. Crystal already gates this behind
    `flag?(:without_playground)`, and the command dispatcher honours it, so
    playground needs no patch -- only `-Dwithout_playground` at compile time.

  * `crystal docs` pulls the `markd` shard (a binding to the md4c C library),
    which is not available and not wanted. There is no existing flag, so this
    adds one in the same style: skip the two files and make the dispatcher
    report the build has no docs support.

Each edit is an idempotent literal replacement; the script refuses to continue if
a target does not contain the expected text, so a Crystal version bump fails
loudly instead of silently skipping a fix.
"""
import pathlib
import sys

DOCS_SHIM_OLD = 'require "./doc/*"'
DOCS_SHIM_NEW = '{% skip_file if flag?(:without_docs) %}\n\nrequire "./doc/*"'

DOCS_CMD_OLD = "# Implementation of the `crystal docs` command"
DOCS_CMD_NEW = (
    "{% skip_file if flag?(:without_docs) %}\n\n"
    "# Implementation of the `crystal docs` command"
)

DISPATCH_OLD = """    when "docs".starts_with?(command)
      options.shift
      docs"""

DISPATCH_NEW = """    when "docs".starts_with?(command)
      options.shift
      {% if flag?(:without_docs) %}
        puts "Crystal was compiled without docs support"
        exit 1
      {% else %}
        docs
      {% end %}"""

# libffi's ABI enum has no wasm32 entry, so the compiler's FFI bindings fail to
# compile for the target. wasm32 is ILP32 like i386-unix, so it takes the same
# values; FFI cannot actually run on WASI (no dlopen), but it must typecheck.
FFI_ABI_OLD = """      {% else %}
        {% raise "Unsupported target for ABI" %}
      {% end %}"""

FFI_ABI_NEW = """      {% elsif flag?(:wasm32) %}
        # wasm32 is ILP32, like i386-unix -- the closest libffi ABI.
        SYSV     = 1
        THISCALL = 3
        FASTCALL
        STDCALL
        PASCAL
        REGISTER
        MS_CDECL
        LAST

        DEFAULT = SYSV
      {% else %}
        {% raise "Unsupported target for ABI" %}
      {% end %}"""

PATCHES = [
    ("compiler/crystal/tools/doc.cr", DOCS_SHIM_OLD, DOCS_SHIM_NEW),
    ("compiler/crystal/command/docs.cr", DOCS_CMD_OLD, DOCS_CMD_NEW),
    ("compiler/crystal/command.cr", DISPATCH_OLD, DISPATCH_NEW),
    ("compiler/crystal/ffi/lib_ffi.cr", FFI_ABI_OLD, FFI_ABI_NEW),
]


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = pathlib.Path(sys.argv[1])
    if not (root / "compiler/crystal.cr").is_file():
        print(f"not a Crystal source tree: {root}", file=sys.stderr)
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
