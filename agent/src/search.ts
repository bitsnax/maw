// Project search: glob (file names) and search (file contents), both
// through ripgrep (in the image; the hosts don't have it).
//
// ripgrep runs in the project root without a shell. Its defaults do the
// right thing for a project:
//   - .gitignore, .ignore and .rgignore are respected (node_modules,
//     build output and the like are skipped);
//   - symbolic links are NOT followed, so a link pointing out of the
//     root cannot be used to read outside it;
//   - binary files are skipped by search.
// Hidden files are included (.env.example, .github/...), except .git.
//
// Results are capped (glob 1,000, search 500) and every run has a time
// limit; when either is hit, the results so far are returned with
// truncated: true.

import { spawn } from "node:child_process"
import { statSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { resolveInRoot } from "./guard.js"
import { HttpError } from "./containers.js"

export const MAX_GLOB = 1000
export const MAX_SEARCH = 500
export const MAX_TEXT_CHARS = 2000
export const RG_TIMEOUT_MS = 20_000

export type SearchOptions = { base: string; timeoutMs?: number }

type RgRun = { code: number | null; stderr: string; stopped: boolean; timedOut: boolean }

/** Runs rg; calls onLine per stdout line until it returns false (then rg is stopped). */
function runRg(args: string[], cwd: string, timeoutMs: number, onLine: (line: string) => boolean): Promise<RgRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    let stopped = false
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeoutMs)
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (d: string) => { if (stderr.length < 8192) stderr += d })
    const rl = createInterface({ input: child.stdout })
    rl.on("line", (line) => {
      if (stopped) return
      if (!onLine(line)) {
        stopped = true
        child.kill("SIGKILL")
      }
    })
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(e.code === "ENOENT" ? new HttpError(503, "ripgrep (rg) is not installed in this agent image.") : e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stderr, stopped, timedOut })
    })
  })
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) throw new HttpError(400, `${what} must be a non-empty string.`)
  if (v.includes("\0")) throw new HttpError(400, `${what} contains a NUL character.`)
  return v
}

function limitOf(v: unknown, max: number): number {
  if (v === undefined || v === null) return max
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new HttpError(400, "limit must be a whole number ≥ 1.")
  return Math.min(v, max)
}

/** The folder to search: the root, or a folder inside it. Returns [cwd, rg path argument]. */
function where(o: SearchOptions, b: Record<string, unknown>): { root: string; arg: string } {
  const r = resolveInRoot(str(b.root, "root"), b.path === undefined ? "." : str(b.path, "path"), o.base)
  let st
  try {
    st = statSync(r.abs)
  } catch {
    throw new HttpError(404, `${r.rel} does not exist.`)
  }
  if (!st.isDirectory()) throw new HttpError(400, `${r.rel} is not a folder.`)
  return { root: r.root, arg: r.rel }
}

// rg prints "./x" for the path ".", "src/x" for "src": make both relative to the root.
const rel = (p: string) => path.normalize(p)

// Errors in the user's pattern are the caller's fault (400), anything else is ours.
function failure(run: RgRun, what: string): HttpError {
  const msg = run.stderr.trim().split("\n").slice(0, 6).join("\n") || `rg exited with code ${run.code}`
  return /regex parse error|error parsing glob|unrecognized|invalid/i.test(msg)
    ? new HttpError(400, `Invalid ${what}: ${msg}`)
    : new HttpError(500, msg)
}

const COMMON = ["--hidden", "--no-config", "--color=never"]
// With --hidden, rg would list .git's contents; this keeps them out.
const NO_GIT = "--glob=!.git"

/**
 * A glob as a regular expression, gitignore style: without a "/" the
 * pattern matches the file name at any depth ("*.ts"); with one it matches
 * the path from the root ("src/**\/*.ts"). Supports *, **, ?, {a,b} and
 * [abc] / [!abc].
 *
 * The match (glob's pattern, search's include) is done here rather than
 * with rg's --glob, because in rg an explicit --glob overrides .gitignore:
 * "*" would list node_modules, and include ".env" would search the
 * ignored .env.
 */
export function globToRegExp(glob: string): { re: RegExp; byName: boolean } {
  let g = glob.replace(/^\.\//, "")
  const anchored = g.startsWith("/")
  if (anchored) g = g.slice(1)
  const byName = !anchored && !g.includes("/")
  let out = ""
  let braces = 0
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!
    if (ch === "*") {
      if (g[i + 1] === "*") {
        const before = i === 0 || g[i - 1] === "/"
        const after = g[i + 2]
        if (before && after === "/") { out += "(?:.*/)?"; i += 2; continue }
        out += ".*"; i += 1; continue
      }
      out += "[^/]*"
    } else if (ch === "?") out += "[^/]"
    else if (ch === "{") { braces++; out += "(?:" }
    else if (ch === "}" && braces > 0) { braces--; out += ")" }
    else if (ch === "," && braces > 0) out += "|"
    else if (ch === "[") {
      const end = g.indexOf("]", i + 2)
      if (end === -1) { out += "\\["; continue }
      let cls = g.slice(i + 1, end).replace(/\\/g, "\\\\")
      if (cls.startsWith("!")) cls = "^" + cls.slice(1)
      out += `[${cls}]`
      i = end
    } else out += ch.replace(/[.+^$()|\\\]]/g, "\\$&")
  }
  if (braces > 0) throw new HttpError(400, `Invalid pattern: unclosed "{" in ${glob}`)
  // "dir/**" also matches "dir" itself; files only are listed, so that is harmless.
  out = out.replace(/\/\.\*$/, "(?:/.*)?")
  return { re: new RegExp(`^${out}$`), byName }
}

export type GlobResult = { path: string; files: string[]; truncated: boolean }

/** Files (not ignored) whose path matches a glob, newest first. */
export async function fsGlob(o: SearchOptions, b: Record<string, unknown>): Promise<GlobResult> {
  const pattern = str(b.pattern, "pattern")
  const limit = limitOf(b.limit, MAX_GLOB)
  const w = where(o, b)
  const { re, byName } = globToRegExp(pattern)
  const files: string[] = []
  const run = await runRg(["--files", ...COMMON, NO_GIT, "--", w.arg], w.root, o.timeoutMs ?? RG_TIMEOUT_MS,
    (line) => {
      const f = rel(line)
      if (re.test(byName ? path.basename(f) : f)) files.push(f)
      return files.length <= limit
    })
  if (!run.stopped && !run.timedOut && run.code === 2 && files.length === 0) throw failure(run, "pattern")
  const truncated = run.stopped || run.timedOut || files.length > limit
  const kept = files.slice(0, limit)
  const mtime = new Map(kept.map((f) => {
    try { return [f, statSync(path.join(w.root, f)).mtimeMs] as const } catch { return [f, 0] as const }
  }))
  kept.sort((a, c) => mtime.get(c)! - mtime.get(a)! || a.localeCompare(c))
  return { path: w.arg, files: kept, truncated }
}

export type SearchMatch = { file: string; line: number; text: string }
export type SearchResult = { path: string; matches: SearchMatch[]; truncated: boolean }

type RgJson = { type: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }

/** Lines matching a regular expression (ripgrep / Rust syntax), sorted by file and line. */
export async function fsSearch(o: SearchOptions, b: Record<string, unknown>): Promise<SearchResult> {
  const pattern = str(b.pattern, "pattern")
  const limit = limitOf(b.limit, MAX_SEARCH)
  const w = where(o, b)
  const args = ["--json", ...COMMON, "--max-filesize=2M"]
  if (b.ignoreCase === true) args.push("--ignore-case")
  const include = b.include === undefined ? null : globToRegExp(str(b.include, "include"))
  args.push(NO_GIT, "--regexp", pattern, "--", w.arg)
  const matches: SearchMatch[] = []
  const run = await runRg(args, w.root, o.timeoutMs ?? RG_TIMEOUT_MS, (line) => {
    let ev: RgJson
    try { ev = JSON.parse(line) as RgJson } catch { return true }
    const d = ev.data
    if (ev.type !== "match" || !d?.path?.text || typeof d.line_number !== "number") return true
    const file = rel(d.path.text)
    if (include && !include.re.test(include.byName ? path.basename(file) : file)) return true
    let text = (d.lines?.text ?? "").replace(/\r?\n$/, "")
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + "..."
    matches.push({ file, line: d.line_number, text })
    return matches.length <= limit
  })
  if (!run.stopped && !run.timedOut && run.code === 2 && matches.length === 0) throw failure(run, "pattern")
  const truncated = run.stopped || run.timedOut || matches.length > limit
  const kept = matches.slice(0, limit)
  kept.sort((a, c) => a.file.localeCompare(c.file) || a.line - c.line)
  return { path: w.arg, matches: kept, truncated }
}
