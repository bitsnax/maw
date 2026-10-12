// Root confinement for every file and command request.
//
// A request names a project root and a path inside it. Both are checked
// with symbolic links followed, so a link inside the project that points
// elsewhere cannot be used to reach outside it:
//   - the root must be an absolute path to an existing folder, and lie
//     inside the allowed base (default /opt, the only host folder the
//     agent mounts);
//   - the target must lie inside the root. For a path that does not exist
//     yet (a new file), its nearest existing parent folder is checked.

import { realpathSync, statSync } from "node:fs"
import path from "node:path"

export class GuardError extends Error {
  readonly status = 400
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function clean(p: string, what: string): string {
  if (typeof p !== "string" || p.length === 0) throw new GuardError(`${what} is required.`)
  if (p.includes("\0")) throw new GuardError(`${what} contains a NUL character.`)
  if (p.length > 4096) throw new GuardError(`${what} is too long.`)
  return p
}

/** Checks a project root; returns its real (links resolved) absolute path. */
export function checkRoot(root: string, base = "/opt"): string {
  clean(root, "Root")
  if (!path.isAbsolute(root)) throw new GuardError(`Root must be an absolute path (got "${root}").`)
  let realBase: string
  try {
    realBase = realpathSync(base)
  } catch {
    throw new GuardError(`The allowed base ${base} does not exist on this machine.`)
  }
  let real: string
  try {
    real = realpathSync(root)
  } catch {
    throw new GuardError(`Root ${root} does not exist.`)
  }
  if (!statSync(real).isDirectory()) throw new GuardError(`Root ${root} is not a folder.`)
  if (!inside(real, realBase)) throw new GuardError(`Root ${root} is outside ${base}.`)
  return real
}

export type Resolved = { root: string; abs: string; rel: string; exists: boolean }

/** Resolves `p` (relative to the root, or absolute inside it). */
export function resolveInRoot(root: string, p: string, base = "/opt"): Resolved {
  const realRoot = checkRoot(root, base)
  clean(p, "Path")
  const wanted = path.resolve(realRoot, p)
  if (!inside(wanted, realRoot)) throw new GuardError(`${p} is outside the root ${root}.`)

  // Follow links: the existing path itself, or its nearest existing parent.
  let probe = wanted
  let missing = ""
  for (;;) {
    try {
      const real = realpathSync(probe)
      const abs = missing ? path.join(real, missing) : real
      if (!inside(abs, realRoot)) throw new GuardError(`${p} leads outside the root ${root} (through a link).`)
      return { root: realRoot, abs, rel: path.relative(realRoot, abs) || ".", exists: missing === "" }
    } catch (e) {
      if (e instanceof GuardError) throw e
      const parent = path.dirname(probe)
      if (parent === probe) throw new GuardError(`${p} cannot be resolved.`)
      missing = missing ? path.join(path.basename(probe), missing) : path.basename(probe)
      probe = parent
    }
  }
}
