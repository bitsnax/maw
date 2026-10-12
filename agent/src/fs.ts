// File endpoints: read, list, write, edit — always inside a project root.
//
// The agent reads and writes through its /opt mount itself (no shell per
// call). Ownership is kept right for the developer:
//   - a new file is given to the run-as user (uid and gid read from the
//     host at start, see host.ts) with mode 664; each folder created on
//     the way gets the same owner and mode 775;
//   - an existing file is rewritten in place, so it keeps its owner,
//     mode and inode (a single-file bind mount elsewhere still sees it).
// Writes need the host identity; reads and lists do not.
//
// Read and edit follow OpenCode's tool rules, so Phase 3 can forward
// OpenCode's read and edit calls here unchanged in meaning:
//   - read: numbered lines ("00001| text"), offset (0-based) and limit
//     (default 2000), long lines cut at 2000 characters; binary files and
//     files over 2 MB are refused;
//   - edit: oldString must be found exactly; found more than once is
//     refused unless replaceAll is set.

import {
  chmodSync, chownSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, readSync, statSync, writeFileSync, type Stats,
} from "node:fs"
import path from "node:path"
import { resolveInRoot } from "./guard.js"
import { HttpError } from "./containers.js"
import type { HostIdentity } from "./host.js"

export const MAX_READ_BYTES = 2 * 1024 * 1024
export const MAX_WRITE_BYTES = 4 * 1024 * 1024
export const DEFAULT_READ_LIMIT = 2000
export const MAX_LINE_CHARS = 2000
export const MAX_LIST_ENTRIES = 5000

export type FsOptions = { base: string; identity: HostIdentity }

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new HttpError(400, `${what} must be a string.`)
  return v
}
function optInt(v: unknown, what: string, min: number): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new HttpError(400, `${what} must be a whole number ≥ ${min}.`)
  return v
}

function statOrThrow(abs: string, shown: string): Stats {
  try {
    return statSync(abs)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") throw new HttpError(404, `${shown} does not exist.`)
    if (code === "EACCES") throw new HttpError(403, `${shown}: permission denied.`)
    throw e
  }
}

/** True when the first bytes look like a binary file (NUL byte, or >30% control characters). */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  if (n === 0) return false
  let odd = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]!
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) odd++
  }
  return odd / n > 0.3
}

function head(abs: string): Buffer {
  const fd = openSync(abs, "r")
  try {
    const buf = Buffer.alloc(8192)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

/** Reads a text file that is safe to show and edit; refuses folders, binary and large files. */
function readText(abs: string, shown: string): { text: string; st: Stats } {
  const st = statOrThrow(abs, shown)
  if (st.isDirectory()) throw new HttpError(400, `${shown} is a folder.`)
  if (!st.isFile()) throw new HttpError(400, `${shown} is not a regular file.`)
  if (st.size > MAX_READ_BYTES) {
    throw new HttpError(413, `${shown} is ${(st.size / 1048576).toFixed(1)} MB; files over 2 MB are not read.`)
  }
  if (looksBinary(head(abs))) throw new HttpError(415, `${shown} is a binary file.`)
  return { text: readFileSync(abs, "utf8"), st }
}

export type ReadResult = {
  path: string; content: string; offset: number; lines: number; totalLines: number; more: boolean
}

export function fsRead(o: FsOptions, b: Record<string, unknown>): ReadResult {
  const r = resolveInRoot(str(b.root, "root"), str(b.path, "path"), o.base)
  const offset = optInt(b.offset, "offset", 0) ?? 0
  const limit = optInt(b.limit, "limit", 1) ?? DEFAULT_READ_LIMIT
  const { text } = readText(r.abs, r.rel)
  const all = text.length === 0 ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/)
  if (offset > all.length) throw new HttpError(400, `offset ${offset} is past the end (${all.length} lines).`)
  const slice = all.slice(offset, offset + limit)
  const content = slice
    .map((line, i) => {
      const cut = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "..." : line
      return `${String(offset + i + 1).padStart(5, "0")}| ${cut}`
    })
    .join("\n")
  return { path: r.rel, content, offset, lines: slice.length, totalLines: all.length, more: offset + slice.length < all.length }
}

export type ListEntry = {
  name: string; type: "file" | "dir" | "link" | "other"; target?: "file" | "dir" | "other" | "broken"
  size: number; modified: string
}

function kind(st: Stats): "file" | "dir" | "other" {
  return st.isFile() ? "file" : st.isDirectory() ? "dir" : "other"
}

export function fsList(o: FsOptions, b: Record<string, unknown>): { path: string; entries: ListEntry[]; truncated: boolean } {
  const r = resolveInRoot(str(b.root, "root"), b.path === undefined ? "." : str(b.path, "path"), o.base)
  const st = statOrThrow(r.abs, r.rel)
  if (!st.isDirectory()) throw new HttpError(400, `${r.rel} is not a folder.`)
  const names = readdirSync(r.abs)
  const entries: ListEntry[] = []
  for (const name of names) {
    const full = path.join(r.abs, name)
    let l: Stats
    try {
      l = lstatSync(full)
    } catch {
      continue // removed while listing
    }
    const e: ListEntry = { name, type: l.isSymbolicLink() ? "link" : kind(l), size: l.size, modified: l.mtime.toISOString() }
    if (l.isSymbolicLink()) {
      try {
        const t = statSync(full)
        e.target = kind(t)
        e.size = t.size
      } catch {
        e.target = "broken"
      }
    }
    entries.push(e)
  }
  const isDir = (e: ListEntry) => e.type === "dir" || e.target === "dir"
  entries.sort((a, c) => (isDir(a) === isDir(c) ? a.name.localeCompare(c.name) : isDir(a) ? -1 : 1))
  return { path: r.rel, entries: entries.slice(0, MAX_LIST_ENTRIES), truncated: entries.length > MAX_LIST_ENTRIES }
}

function owner(o: FsOptions): { uid: number; gid: number } {
  if (!o.identity.ok) throw new HttpError(503, `Writing files is unavailable: ${o.identity.error}`)
  return { uid: o.identity.uid, gid: o.identity.gid }
}

export function fsWrite(o: FsOptions, b: Record<string, unknown>): { path: string; created: boolean; bytes: number } {
  const own = owner(o)
  const content = str(b.content, "content")
  const bytes = Buffer.byteLength(content)
  if (bytes > MAX_WRITE_BYTES) throw new HttpError(413, `content is ${(bytes / 1048576).toFixed(1)} MB; at most 4 MB.`)
  const r = resolveInRoot(str(b.root, "root"), str(b.path, "path"), o.base)
  if (r.exists) {
    const st = statOrThrow(r.abs, r.rel)
    if (st.isDirectory()) throw new HttpError(400, `${r.rel} is a folder.`)
    if (!st.isFile()) throw new HttpError(400, `${r.rel} is not a regular file.`)
    writeFileSync(r.abs, content) // in place: owner, mode and inode stay
    return { path: r.rel, created: false, bytes }
  }
  // Create missing folders one by one so each gets the user's owner and 775.
  const parent = path.dirname(r.abs)
  const missing: string[] = []
  for (let p = parent; ; p = path.dirname(p)) {
    try {
      const st = statSync(p)
      if (!st.isDirectory()) throw new HttpError(400, `${path.relative(r.root, p)} is a file, not a folder.`)
      break
    } catch (e) {
      if (e instanceof HttpError) throw e
      missing.unshift(p)
    }
  }
  for (const d of missing) {
    mkdirSync(d)
    chownSync(d, own.uid, own.gid)
    chmodSync(d, 0o775)
  }
  writeFileSync(r.abs, content, { flag: "wx" })
  chownSync(r.abs, own.uid, own.gid)
  chmodSync(r.abs, 0o664)
  return { path: r.rel, created: true, bytes }
}

export function fsEdit(o: FsOptions, b: Record<string, unknown>): { path: string; replacements: number } {
  owner(o)
  const oldString = str(b.oldString, "oldString")
  const newString = str(b.newString, "newString")
  const replaceAll = b.replaceAll === true
  if (oldString.length === 0) throw new HttpError(400, "oldString is empty; use write to create or replace a whole file.")
  if (oldString === newString) throw new HttpError(400, "oldString and newString are the same.")
  const r = resolveInRoot(str(b.root, "root"), str(b.path, "path"), o.base)
  const { text } = readText(r.abs, r.rel)
  const count = text.split(oldString).length - 1
  if (count === 0) throw new HttpError(422, `oldString was not found in ${r.rel}.`)
  if (count > 1 && !replaceAll) {
    throw new HttpError(422, `oldString was found ${count} times in ${r.rel}; give more surrounding text to make it unique, or set replaceAll.`)
  }
  const out = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
  if (Buffer.byteLength(out) > MAX_WRITE_BYTES) throw new HttpError(413, "The edited file would be over 4 MB.")
  writeFileSync(r.abs, out) // in place: owner, mode and inode stay
  return { path: r.rel, replacements: replaceAll ? count : 1 }
}
