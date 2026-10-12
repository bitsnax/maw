// Who commands and new files belong to on the host.
//
// The agent runs with pid: host and privileged (install file), so the
// host's root file system is visible at /proc/1/root. At start it reads the
// run-as user's uid, gid and home from the host's /etc/passwd and the
// host's default LANG from /etc/default/locale. Without that access (an
// agent started without pid: host) it still runs; file writes and commands
// then report why they are unavailable.

import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"

export type HostIdentity =
  | { ok: true; user: string; uid: number; gid: number; home: string; lang: string }
  | { ok: false; user: string; error: string }

export function parsePasswd(text: string, user: string): { uid: number; gid: number; home: string } | null {
  for (const line of text.split("\n")) {
    const f = line.split(":")
    if (f[0] === user && f.length >= 7) {
      const uid = Number(f[2])
      const gid = Number(f[3])
      if (Number.isInteger(uid) && Number.isInteger(gid)) return { uid, gid, home: f[5] ?? "" }
    }
  }
  return null
}

export function parseLocale(text: string): string {
  for (const line of text.split("\n")) {
    const m = /^\s*LANG\s*=\s*"?([^"\s]+)"?\s*$/.exec(line)
    if (m) return m[1]!
  }
  return "C.UTF-8"
}

export function readHostIdentity(user: string, hostRoot = "/proc/1/root"): HostIdentity {
  if (!user) return { ok: false, user, error: "MAW_RUN_AS is not set." }
  let passwd: string
  try {
    passwd = readFileSync(`${hostRoot}/etc/passwd`, "utf8")
  } catch {
    return { ok: false, user, error: "Cannot read the host's /etc/passwd (is the agent running with pid: host and privileged?)." }
  }
  const p = parsePasswd(passwd, user)
  if (!p) return { ok: false, user, error: `User ${user} does not exist on this machine.` }
  let lang = "C.UTF-8"
  try {
    lang = parseLocale(readFileSync(`${hostRoot}/etc/default/locale`, "utf8"))
  } catch { /* no locale file: keep C.UTF-8 */ }
  return { ok: true, user, ...p, lang }
}

/** ripgrep's version, or null if it is not in the image. */
export function ripgrepVersion(): string | null {
  try {
    const out = execFileSync("rg", ["--version"], { encoding: "utf8", timeout: 5000 })
    return /ripgrep\s+(\S+)/.exec(out)?.[1] ?? out.split("\n")[0] ?? null
  } catch {
    return null
  }
}
