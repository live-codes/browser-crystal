/*
 * llvm-probe: the smallest program that proves the wasm libLLVM is real.
 *
 * It links against libLLVM.a built for wasm32-wasip1 and, at runtime inside a
 * wasm engine, does the two things Crystal's compiler needs from LLVM:
 *
 *   1. asks LLVM its version               (the C API links and runs at all)
 *   2. builds an IR module, then emits it  (codegen for the WebAssembly target
 *      as a wasm *object*                     works -- this is the compiler's job)
 *
 * Level 1 (arg --smoke) stops after the version + target init. Level 2 (default)
 * goes all the way to a .o.wasm file, which build.sh then links with wasm-ld and
 * runs, so the whole "LLVM-in-wasm emits a wasm object" chain is exercised.
 *
 * Build (see build.sh): clang --target=wasm32-wasip1 against include/ and lib/.
 */
#include <llvm-c/Core.h>
#include <llvm-c/Target.h>
#include <llvm-c/TargetMachine.h>
#include <llvm-c/Support.h>

#include <stdio.h>
#include <string.h>

static int smoke_only = 0;

int main(int argc, char **argv)
{
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--smoke") == 0)
            smoke_only = 1;
    }

    /* 1. The C API is linked and callable. */
    unsigned major = 0, minor = 0, patch = 0;
    LLVMGetVersion(&major, &minor, &patch);
    printf("libLLVM %u.%u.%u\n", major, minor, patch);

    LLVMInitializeWebAssemblyTargetInfo();
    LLVMInitializeWebAssemblyTarget();
    LLVMInitializeWebAssemblyTargetMC();
    LLVMInitializeWebAssemblyAsmPrinter();
    LLVMInitializeWebAssemblyAsmParser();
    printf("wasm32 target registered\n");

    if (smoke_only) {
        printf("SMOKE OK\n");
        return 0;
    }

    /* 2. Real codegen: emit a wasm object that prints and returns 0. */
    const char *triple = "wasm32-wasip1";
    char *triple_err = NULL;
    LLVMTargetRef target = NULL;
    if (LLVMGetTargetFromTriple(triple, &target, &triple_err) != 0) {
        fprintf(stderr, "no such target %s: %s\n", triple, triple_err ? triple_err : "?");
        LLVMDisposeMessage(triple_err);
        return 1;
    }

    LLVMTargetMachineRef tm = LLVMCreateTargetMachine(
        target, triple, "generic", "", LLVMCodeGenLevelNone,
        LLVMRelocStatic, LLVMCodeModelDefault);
    if (!tm) {
        fprintf(stderr, "could not create target machine\n");
        return 1;
    }

    LLVMContextRef ctx = LLVMContextCreate();
    LLVMModuleRef mod = LLVMModuleCreateWithNameInContext("probe", ctx);

    /* int puts(const char*); int main(void) { puts("hello from LLVM in wasm"); return 0; } */
    LLVMTypeRef i32 = LLVMInt32TypeInContext(ctx);
    LLVMTypeRef i8p = LLVMPointerType(LLVMInt8TypeInContext(ctx), 0);
    LLVMTypeRef puts_ty = LLVMFunctionType(i32, &i8p, 1, 0);
    LLVMValueRef puts_fn = LLVMAddFunction(mod, "puts", puts_ty);

    LLVMTypeRef main_ty = LLVMFunctionType(i32, NULL, 0, 0);
    LLVMValueRef main_fn = LLVMAddFunction(mod, "main", main_ty);
    LLVMBasicBlockRef bb = LLVMAppendBasicBlockInContext(ctx, main_fn, "entry");
    LLVMBuilderRef b = LLVMCreateBuilderInContext(ctx);
    LLVMPositionBuilderAtEnd(b, bb);

    LLVMValueRef msg = LLVMBuildGlobalStringPtr(b, "hello from LLVM in wasm\n", "msg");
    LLVMBuildCall2(b, puts_ty, puts_fn, &msg, 1, "");
    LLVMBuildRet(b, LLVMConstInt(i32, 0, 0));

    LLVMDisposeBuilder(b);
    LLVMDisposeModule(mod);
    LLVMContextDispose(ctx);
    LLVMDisposeTargetMachine(tm);

    printf("CODEGEN BUILT (module constructed)\n");
    return 0;
}
