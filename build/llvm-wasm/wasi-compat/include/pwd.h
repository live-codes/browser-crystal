/* pwd.h -- WASI has no user database and ships no <pwd.h>.
 *
 * LLVM's Unix Path.inc includes <pwd.h> to look up the home directory via
 * getpwuid(). The declarations live in wasi-compat.h (force-included anyway);
 * this file exists so the `#include <pwd.h>` resolves.
 */
#ifndef WASI_COMPAT_PWD_SHIM_H
#define WASI_COMPAT_PWD_SHIM_H

#include <wasi-compat.h>

#endif
