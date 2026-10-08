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

# The standard library guards the *bodies* of these two methods for
# `!flag?(:wasm32)`, but their return-type annotations still name `Signal` --
# and `Signal` is not defined on wasm (the prelude skips `require "signal"`).
# Guard the whole methods so the annotation goes with them.
STATUS_SIGNAL_OLD = """  def exit_signal : Signal
    {% if flag?(:unix) && !flag?(:wasm32) %}
      Signal.new(signal_code)
    {% else %}
      raise NotImplementedError.new("Process::Status#exit_signal")
    {% end %}
  end

  # Returns the exit `Signal` or `nil` if there is none.
  #
  # On Windows returns always `nil`.
  #
  # * `#exit_reason` is a portable alternative.
  def exit_signal? : Signal?
    {% if flag?(:unix) && !flag?(:wasm32) %}
      code = signal_code
      unless code.zero?
        Signal.new(code)
      end
    {% end %}
  end"""

STATUS_SIGNAL_NEW = """  {% if flag?(:unix) && !flag?(:wasm32) %}
    def exit_signal : Signal
      Signal.new(signal_code)
    end

    # Returns the exit `Signal` or `nil` if there is none.
    #
    # On Windows returns always `nil`.
    #
    # * `#exit_reason` is a portable alternative.
    def exit_signal? : Signal?
      code = signal_code
      unless code.zero?
        Signal.new(code)
      end
    end
  {% else %}
    # Signals do not exist on this platform; `#exit_reason` is the portable
    # alternative. The type annotation cannot name `Signal` here.
    def exit_signal : NoReturn
      raise NotImplementedError.new("Process::Status#exit_signal")
    end

    def exit_signal? : NoReturn
      raise NotImplementedError.new("Process::Status#exit_signal?")
    end
  {% end %}"""

EXEC_PATH_OLD = """    def self.exec_path
      ENV.fetch("CRYSTAL_EXEC_PATH") do
        executable_path = Process.executable_path || return
        File.dirname(executable_path)
      end
    end"""

EXEC_PATH_NEW = """    def self.exec_path : String
      ENV.fetch("CRYSTAL_EXEC_PATH") do
        {% if flag?(:wasm32) %}
          # WASI has no executable path; the compiler is configured through ENV.
          ""
        {% else %}
          executable_path = Process.executable_path
          executable_path ? File.dirname(executable_path) : ""
        {% end %}
      end
    end"""

# Crystal 1.17's WASI event loop leaves file open() as a NotImplementedError, so
# a Crystal program on wasm cannot read a file at all -- which a compiler must.
# The other event loops (see event_loop/polling.cr) all open with `LibC.open`;
# WASI can too, because wasi-libc implements open(2) over path_open against the
# preopened directories. WASI has no O_CLOEXEC and no way to change blocking
# mode after the fact, so the flags go through untouched and the descriptor is
# reported blocking (which is what it is).
WASI_OPEN_OLD = """  def open(filename : String, flags : Int32, permissions : File::Permissions, blocking : Bool?) : {System::FileDescriptor::Handle, Bool} | Errno | WinError
    raise NotImplementedError.new("Crystal::Wasi::EventLoop#open")
  end"""

WASI_OPEN_NEW = """  def open(filename : String, flags : Int32, permissions : File::Permissions, blocking : Bool?) : {System::FileDescriptor::Handle, Bool} | Errno | WinError
    filename.check_no_null_byte

    fd = LibC.open(filename, flags, permissions)
    return Errno.value if fd == -1

    # A descriptor from a WASI filesystem is blocking; there is no non-blocking
    # mode to switch to, so the caller is told what is true rather than what was
    # asked for.
    {fd, true}
  end"""

# Crystal 1.17 deliberately does not implement exceptions on wasm32: raise()
# calls `LibIntrinsics.debugtrap` (the `unreachable` seen at every run), and the
# three runtime hooks print "EXITING: ..." and exit. But the machinery for the
# Itanium landing-pad path is all present -- LLVM's wasm EH uses
# WasmEHPrepare + `_Unwind_CallPersonality` + `__wasm_lpad_context`, and
# libunwind's wasm port (Unwind-wasm.c) provides `_Unwind_RaiseException`
# (a `wasm throw`), `_Unwind_GetIP`, `_Unwind_GetLanguageSpecificData` and
# `_Unwind_SetGR`. So the wasm stubs are removed and wasm uses the same
# implementations as every other platform.
WASM_RAISE_STUBS_OLD = """{% elsif flag?(:wasm32) %}
  # :nodoc:
  fun __crystal_personality
    Crystal::System.print_error "EXITING: __crystal_personality called"
    LibC.exit(1)
  end

  # :nodoc:
  @[Raises]
  fun __crystal_raise(ex : Void*) : NoReturn
    Crystal::System.print_error "EXITING: __crystal_raise called"
    LibC.exit(1)
  end

  # :nodoc:
  fun __crystal_get_exception(ex : Void*) : UInt64
    Crystal::System.print_error "EXITING: __crystal_get_exception called"
    LibC.exit(1)
    0u64
  end
{% else %}"""

WASM_RAISE_STUBS_NEW = """{% else %}"""

WASM_RAISE_UNLESS_OLD = "{% unless flag?(:interpreted) || (flag?(:win32) && !flag?(:gnu)) || flag?(:wasm32) %}"
WASM_RAISE_UNLESS_NEW = "{% unless flag?(:interpreted) || (flag?(:win32) && !flag?(:gnu)) %}"

WASM_RAISE_DEF_OLD = """{% if flag?(:wasm32) %}
  def raise(exception : Exception) : NoReturn
    Crystal::System.print_error "EXITING: Attempting to raise:\\n%s\\n", exception.inspect_with_backtrace
    LibIntrinsics.debugtrap
    LibC.exit(1)
  end
{% else %}
  # Raises the *exception*."""

WASM_RAISE_DEF_NEW = """  # Raises the *exception*."""

WASM_RAISE_DEF_END_OLD = """    exception.callstack ||= Exception::CallStack.new
    raise_without_backtrace(exception)
  end
{% end %}"""

WASM_RAISE_DEF_END_NEW = """    exception.callstack ||= Exception::CallStack.new
    raise_without_backtrace(exception)
  end"""

# `exception/call_stack.cr` picks `call_stack/null` on wasm, which does not
# require `exception/lib_unwind` -- so `LibUnwind` is not in scope once wasm uses
# the real raise path. Require it directly.
RAISE_REQUIRE_OLD = 'require "exception/call_stack"'
RAISE_REQUIRE_NEW = """require "exception/call_stack"
{% unless flag?(:interpreted) %}
  require "exception/lib_unwind"
{% end %}"""

# `raise` calls `Exception::CallStack.print_backtrace`, which the interpreter and
# libunwind call-stack implementations define but the null one (used on wasm)
# does not. A wasm backtrace is empty anyway; this satisfies the interface.
NULL_BACKTRACE_OLD = """  protected def self.decode_frame(pc)
    nil
  end"""

NULL_BACKTRACE_NEW = """  # The other call-stack implementations provide this; raise needs it.
  def self.print_backtrace : Nil
  end

  protected def self.decode_frame(pc)
    nil
  end"""

# The rescue landing pad, for the non-MSVC (Itanium) path. Two things are wrong
# for wasm:
#
#   * it has **no clauses**, and wasm's personality (libc++abi's
#     `__gxx_personality_wasm0`, which WasmEHPrepare hardcodes through
#     `_Unwind_CallPersonality`) only enters the pad when a clause matches --
#     otherwise it rethrows and the exception escapes the module;
#   * its second slot is read as the exception's type id, but that slot is
#     filled by *Crystal's* personality, which wasm never calls; libc++abi puts
#     a clause index there instead.
#
# So on wasm the pad declares a catch-all (Crystal wants every exception and
# dispatches itself) and the type id is read off the exception object, which
# begins with it -- the same thing the msvc path above already does.
CODEGEN_RESCUE_OLD = """      else
        # Unwind exception handling code - used on non-MSVC platforms (essentially the Itanium
        # C++ ABI) - is a lot simpler.
        # First we generate the landing pad instruction, this returns a tuple of the libunwind
        # exception object and the type ID of the exception. This tuple is set up in the crystal
        # personality function in raise.cr
        lp_ret_type = llvm_typer.landing_pad_type
        lp = builder.landing_pad lp_ret_type, main_fun(personality_name).func, [] of LLVM::Value
        unwind_ex_obj = extract_value lp, 0
        exception_type_id = extract_value lp, 1

        # We call __crystal_get_exception to get the actual crystal `Exception` object.
        get_exception_fun = main_fun(GET_EXCEPTION_NAME)
        get_exception_arg_type = get_exception_fun.type.params_types.first # Void* or LibUnwind::Exception*
        get_exception_arg = pointer_cast(unwind_ex_obj, get_exception_arg_type)

        set_current_debug_location node if @debug.line_numbers?
        caught_exception_ptr = call get_exception_fun, [get_exception_arg]
        caught_exception = int2ptr caught_exception_ptr, llvm_typer.type_id_pointer
      end"""

CODEGEN_RESCUE_NEW = """      else
        # Unwind exception handling code - used on non-MSVC platforms (essentially the Itanium
        # C++ ABI) - is a lot simpler.
        # First we generate the landing pad instruction, this returns a tuple of the libunwind
        # exception object and the type ID of the exception. This tuple is set up in the crystal
        # personality function in raise.cr.
        #
        # On wasm the personality is libc++abi's, not ours: WasmEHPrepare hardcodes
        # `_Unwind_CallPersonality`, which calls `__gxx_personality_wasm0`. That one only enters
        # the pad when a clause matches -- otherwise it rethrows and the exception escapes the
        # module -- and it puts a clause index in the selector slot, not a type id. So a wasm
        # target declares a catch-all (Crystal wants every exception and dispatches itself) and
        # reads the type id off the exception object, which begins with it.
        #
        # This is a *runtime* check on the target, not `flag?(:wasm32)`: the latter is evaluated
        # when the compiler is built, so a natively-built compiler would take the else branch.
        wasm_target = @program.target_machine.triple.starts_with?("wasm32")
        lp_ret_type = llvm_typer.landing_pad_type
        # A catch-all clause is a null i8* constant, as LLVM's own IR spells it;
        # passing a null ValueRef instead leaves the pad invalid.
        clauses = wasm_target ? [llvm_context.int8.pointer.null] : [] of LLVM::Value
        lp = builder.landing_pad lp_ret_type, main_fun(personality_name).func, clauses
        unwind_ex_obj = extract_value lp, 0

        # We call __crystal_get_exception to get the actual crystal `Exception` object.
        get_exception_fun = main_fun(GET_EXCEPTION_NAME)
        get_exception_arg_type = get_exception_fun.type.params_types.first # Void* or LibUnwind::Exception*
        get_exception_arg = pointer_cast(unwind_ex_obj, get_exception_arg_type)

        set_current_debug_location node if @debug.line_numbers?
        caught_exception_ptr = call get_exception_fun, [get_exception_arg]
        caught_exception = int2ptr caught_exception_ptr, llvm_typer.type_id_pointer
        exception_type_id = wasm_target ? load(llvm_context.int32, caught_exception) : extract_value(lp, 1)
      end"""

CODEGEN_ENSURE_OLD = """          lp_ret_type = llvm_typer.landing_pad_type
          lp = builder.landing_pad lp_ret_type, main_fun(personality_name).func, [] of LLVM::Value
          unwind_ex_obj = extract_value lp, 0"""

CODEGEN_ENSURE_NEW = """          lp_ret_type = llvm_typer.landing_pad_type
          # As in the rescue pad: a wasm target needs a clause or it rethrows.
          clauses = @program.target_machine.triple.starts_with?("wasm32") ? [llvm_context.int8.pointer.null] : [] of LLVM::Value
          lp = builder.landing_pad lp_ret_type, main_fun(personality_name).func, clauses
          unwind_ex_obj = extract_value lp, 0"""

# The msvc/funclet branch selector. `msvc` is a runtime program flag, so a wasm
# target can join it rather than being handled with compile-time macros.
MSVC_BRANCH_OLD = '    msvc = @program.has_flag?("msvc")'
MSVC_BRANCH_NEW = """    msvc = @program.has_flag?("msvc")
    # WebAssembly's exception handling in LLVM uses the funclet representation
    # (catchswitch/catchpad, lowered to `catch __cpp_exception`), which is the
    # same shape as the msvc path -- so a wasm target takes it.
    wasm_target = @program.target_machine.triple.starts_with?("wasm32")
    funclet_eh = msvc || wasm_target"""

MSVC_IF_RESCUE_OLD = """      if msvc
        # Windows structured exception handling must enter a catch_switch instruction"""
MSVC_IF_RESCUE_NEW = """      if funclet_eh
        # Windows structured exception handling must enter a catch_switch instruction"""

MSVC_IF_ENSURE_OLD = """        if msvc
          rescue_ensure_body = new_block "rescue_ensure_body\""""
MSVC_IF_ENSURE_NEW = """        if funclet_eh
          rescue_ensure_body = new_block "rescue_ensure_body\""""

PATCHES = [
    ("compiler/crystal/tools/doc.cr", DOCS_SHIM_OLD, DOCS_SHIM_NEW),
    ("compiler/crystal/command/docs.cr", DOCS_CMD_OLD, DOCS_CMD_NEW),
    ("compiler/crystal/command.cr", DISPATCH_OLD, DISPATCH_NEW),
    ("compiler/crystal/ffi/lib_ffi.cr", FFI_ABI_OLD, FFI_ABI_NEW),
    ("process/status.cr", STATUS_SIGNAL_OLD, STATUS_SIGNAL_NEW),
    ("compiler/crystal/config.cr", EXEC_PATH_OLD, EXEC_PATH_NEW),
    ("crystal/event_loop/wasi.cr", WASI_OPEN_OLD, WASI_OPEN_NEW),
    ("raise.cr", WASM_RAISE_STUBS_OLD, WASM_RAISE_STUBS_NEW),
    ("raise.cr", WASM_RAISE_UNLESS_OLD, WASM_RAISE_UNLESS_NEW),
    ("raise.cr", WASM_RAISE_DEF_OLD, WASM_RAISE_DEF_NEW),
    ("raise.cr", WASM_RAISE_DEF_END_OLD, WASM_RAISE_DEF_END_NEW),
    ("raise.cr", RAISE_REQUIRE_OLD, RAISE_REQUIRE_NEW),
    ("exception/call_stack/null.cr", NULL_BACKTRACE_OLD, NULL_BACKTRACE_NEW),
    # wasm EH in LLVM uses the funclet representation -- `catchswitch`/`catchpad`,
    # lowered to `catch __cpp_exception` (WebAssemblyISelDAGToDAG.cpp) -- which is
    # exactly Crystal's msvc path. Its landingpad path is dropped on wasm: the
    # emitted module had a `throw` and no `try` at all, so the exception escaped.
    ("compiler/crystal/codegen/exception.cr", MSVC_BRANCH_OLD, MSVC_BRANCH_NEW),
    ("compiler/crystal/codegen/exception.cr", MSVC_IF_RESCUE_OLD, MSVC_IF_RESCUE_NEW),
    ("compiler/crystal/codegen/exception.cr", MSVC_IF_ENSURE_OLD, MSVC_IF_ENSURE_NEW),
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
        # Check `old` first: a replacement can be a common string (one patch
        # replaces a block with `{% else %}`), so `new in text` is not a usable
        # "already applied" signal on its own.
        if old in text:
            path.write_text(text.replace(old, new, 1))
            print(f"patched: {rel}")
        elif new in text:
            print(f"already applied: {rel}")
        else:
            print(f"PATCH TARGET CHANGED, cannot apply: {rel}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
