// Commands on the host, as the developer's user, with live output.
//
// A command runs as
//   nsenter -t 1 -m -u -i -n -p -- runuser -l <user> --session-command <script>
// (the agent has pid: host and privileged): the host's mount, UTS, IPC,
// network and PID namespaces, and a login shell, so the user's PATH (nvm,
// pyenv, ~/.local/bin), git identity and SSH work as in a terminal. The
// script sets what a login through runuser does not:
//   umask 0002; export LANG=<host default>; cd <root>
// then prints a marker line on stdout and stderr and runs the command.
// Whatever the login shell's own start-up files print before the marker
// (a profile error, a greeting) is kept but flagged login: true, so it is
// never mistaken for the command's output. The command is passed
// base64-encoded and decoded
// by the shell, so no quoting in it can break out of the script. runuser -l
// clears the environment, and the agent starts nsenter with a minimal one,
// so the agent's own settings (its private key) never reach the command.
//
// Jobs live in memory only (no database): at most 4 running at once, the
// last 2,000 output lines each, kept 1 hour after they end. A job ends as
// exited, stopped or timed out (default limit 600 s, max 3,600 s).
//
// Stop ends the whole process tree. The agent starts nsenter in a new
// session of its own, and --session-command (runuser's -c without the
// extra session -c makes against terminal tricks; there is no terminal
// here) keeps the command in it. The agent finds the job's processes
// through /proc (shared with the host): every descendant of the started
// process, plus every process in a session one of them belongs to (a child
// whose parent died is re-parented, but stays in its session; a command
// that calls setsid itself is learned while it runs). TERM first; whatever is left
// after 5 s gets KILL. Background processes a command leaves behind when
// it exits are ended the same way, as when a terminal closes.

import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { checkRoot } from "./guard.js"
import { HttpError } from "./containers.js"
import type { HostIdentity } from "./host.js"

export const MAX_RUNNING = 4
export const MAX_LINES = 2000
export const MAX_LINE_CHARS = 4000
export const MAX_COMMAND_CHARS = 64 * 1024
export const DEFAULT_TIMEOUT_S = 600
export const MAX_TIMEOUT_S = 3600
export const KEEP_ENDED_MS = 60 * 60 * 1000
export const MAX_KEPT_JOBS = 100
export const KILL_GRACE_MS = 5000

export type JobState = "running" | "exited" | "stopped" | "timed_out" | "failed"
export type OutLine = { seq: number; t: number; stream: "stdout" | "stderr"; text: string; login?: true }

/** Printed by the script on both streams right before the command; never shown. */
export const BEGIN_MARK = "\u001emaw-begin\u001e"
export type JobEvent = { type: "line"; line: OutLine } | { type: "end"; status: JobStatus }

export type JobStatus = {
  id: string
  root: string
  command: string
  state: JobState
  exitCode: number | null
  signal: string | null
  error: string | null
  startedAt: string
  endedAt: string | null
  durationMs: number
  timeoutSeconds: number
  totalLines: number
  droppedLines: number
}

/** Turns the shell script into the program to start (argv). */
export type Launcher = (user: string, script: string) => { file: string; args: string[] }

export const hostLauncher: Launcher = (user, script) => ({
  file: "nsenter",
  args: ["-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "runuser", "-l", user, "--session-command", script],
})

export type ExecOptions = {
  base: string
  identity: () => HostIdentity
  launcher?: Launcher
  procRoot?: string
  killGraceMs?: number
  maxLines?: number
  maxRunning?: number
}

/** Single-quoted for sh: safe for any text without NUL. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The script the login shell runs: environment fixes, cd, then the decoded command. */
export function commandScript(root: string, command: string, lang: string): string {
  const b64 = Buffer.from(command, "utf8").toString("base64")
  return `umask 0002; export LANG=${shq(lang)}; cd ${shq(root)} || exit 126; ` +
    `printf '\\036maw-begin\\036\\n'; printf '\\036maw-begin\\036\\n' >&2; ` +
    `eval "$(printf '%s' ${b64} | base64 -d)"`
}

// ---- /proc --------------------------------------------------------------

type Proc = { pid: number; state: string; ppid: number; sid: number; start: string }

/** pid, parent, session and start time (to tell a reused pid apart) from /proc/<pid>/stat. */
export function parseStat(text: string): Proc | null {
  const close = text.lastIndexOf(")")
  if (close < 0) return null
  const pid = Number(text.slice(0, text.indexOf(" ")))
  const f = text.slice(close + 2).split(" ")
  // After "pid (comm) ": state ppid pgrp session ... starttime is field 22, here index 19.
  const state = f[0] ?? ""
  const ppid = Number(f[1])
  const sid = Number(f[3])
  const start = f[19] ?? ""
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(sid)) return null
  return { pid, state, ppid, sid, start }
}

function readProcs(procRoot: string): Proc[] {
  const out: Proc[] = []
  let names: string[]
  try { names = readdirSync(procRoot) } catch { return out }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    try {
      const p = parseStat(readFileSync(`${procRoot}/${n}/stat`, "utf8"))
      if (p) out.push(p)
    } catch { /* ended meanwhile */ }
  }
  return out
}

function ownSid(procRoot: string): number {
  try { return parseStat(readFileSync(`${procRoot}/self/stat`, "utf8"))?.sid ?? -1 } catch { return -1 }
}

// ---- jobs ---------------------------------------------------------------

type Job = {
  id: string
  root: string
  command: string
  timeoutSeconds: number
  state: JobState
  exitCode: number | null
  signal: string | null
  error: string | null
  started: number
  ended: number | null
  child: ChildProcess | null
  pid: number
  sids: Set<number>
  lines: OutLine[]
  seq: number
  dropped: number
  partial: { stdout: string; stderr: string }
  begun: { stdout: boolean; stderr: boolean }
  listeners: Set<(e: JobEvent) => void>
  timer: NodeJS.Timeout | null
  stopping: Promise<void> | null
  wanted: "stopped" | "timed_out" | null
  exited: Promise<void>
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGPIPE: 13 }

export class ExecManager {
  private jobs = new Map<string, Job>()
  private readonly launcher: Launcher
  private readonly procRoot: string
  private readonly killGraceMs: number
  private readonly maxLines: number
  private readonly maxRunning: number
  private sampler: NodeJS.Timeout | null = null
  private readonly selfSid: number

  constructor(private readonly o: ExecOptions) {
    this.launcher = o.launcher ?? hostLauncher
    this.procRoot = o.procRoot ?? "/proc"
    this.killGraceMs = o.killGraceMs ?? KILL_GRACE_MS
    this.maxLines = o.maxLines ?? MAX_LINES
    this.maxRunning = o.maxRunning ?? MAX_RUNNING
    this.selfSid = ownSid(this.procRoot)
  }

  start(b: Record<string, unknown>): JobStatus {
    this.prune()
    const id0 = this.o.identity()
    if (!id0.ok) throw new HttpError(503, `Running commands is unavailable: ${id0.error}`)
    if (typeof b.root !== "string") throw new HttpError(400, "root must be a string.")
    const root = checkRoot(b.root, this.o.base)
    const command = b.command
    if (typeof command !== "string" || command.trim() === "") throw new HttpError(400, "command must be a non-empty string.")
    if (command.includes("\0")) throw new HttpError(400, "command contains a NUL character.")
    if (command.length > MAX_COMMAND_CHARS) throw new HttpError(400, `command is over ${MAX_COMMAND_CHARS} characters.`)
    let timeoutSeconds = DEFAULT_TIMEOUT_S
    if (b.timeoutSeconds !== undefined && b.timeoutSeconds !== null) {
      const t = b.timeoutSeconds
      if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_S)
        throw new HttpError(400, `timeoutSeconds must be a whole number from 1 to ${MAX_TIMEOUT_S}.`)
      timeoutSeconds = t
    }
    const running = [...this.jobs.values()].filter((j) => j.state === "running").length
    if (running >= this.maxRunning) throw new HttpError(429, `${running} commands are already running on this machine (at most ${this.maxRunning}).`)

    const { file, args } = this.launcher(id0.user, commandScript(root, command, id0.lang))
    const job: Job = {
      id: randomBytes(8).toString("hex"), root, command, timeoutSeconds,
      state: "running", exitCode: null, signal: null, error: null, started: Date.now(), ended: null,
      child: null, pid: 0, sids: new Set(), lines: [], seq: 0, dropped: 0,
      partial: { stdout: "", stderr: "" }, begun: { stdout: false, stderr: false }, listeners: new Set(), timer: null, stopping: null, wanted: null,
      exited: Promise.resolve(),
    }
    let child: ChildProcess
    try {
      child = spawn(file, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // its own session: never the agent's
        env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
      })
    } catch (e) {
      throw new HttpError(500, `Cannot start the command: ${e instanceof Error ? e.message : e}`)
    }
    job.child = child
    job.pid = child.pid ?? 0
    if (job.pid > 1) job.sids.add(job.pid) // detached: the leader of a new session
    this.jobs.set(job.id, job)

    let resolveExited!: () => void
    job.exited = new Promise((r) => { resolveExited = r })
    for (const stream of ["stdout", "stderr"] as const) {
      const s = child[stream]!
      s.setEncoding("utf8")
      s.on("data", (d: string) => this.take(job, stream, d))
      s.on("error", () => { /* destroyed after exit */ })
    }
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      this.flush(job)
      if (job.timer) clearTimeout(job.timer)
      job.ended = Date.now()
      if (job.state === "running") job.state = job.wanted ?? "exited"
      resolveExited()
      const status = this.status(job)
      for (const l of job.listeners) l({ type: "end", status })
      job.listeners.clear()
      job.child = null
    }
    child.on("error", (e: NodeJS.ErrnoException) => {
      job.state = "failed"
      job.error = e.code === "ENOENT" ? `${file} is not available in this agent.` : e.message
      finish()
    })
    child.on("exit", (code, signal) => {
      job.exitCode = code ?? (signal ? 128 + (SIGNALS[signal] ?? 0) : null)
      job.signal = signal
      // Output still held open by a background process: end the leftovers,
      // then close the pipes so the job finishes.
      const late = setTimeout(() => {
        void this.terminate(job, null).then(() => {
          child.stdout?.destroy(); child.stderr?.destroy()
          setTimeout(finish, 50)
        })
      }, 1000)
      child.once("close", () => { clearTimeout(late); finish(); void this.terminate(job, null) })
    })
    job.timer = setTimeout(() => { void this.terminate(job, "timed_out") }, timeoutSeconds * 1000)
    this.ensureSampler()
    return this.status(job)
  }

  get(id: string): Job {
    this.prune()
    const j = this.jobs.get(id)
    if (!j) throw new HttpError(404, `No command ${id} (commands are kept 1 hour after they end).`)
    return j
  }

  status(j: Job): JobStatus {
    return {
      id: j.id, root: j.root, command: j.command, state: j.state, exitCode: j.exitCode, signal: j.signal, error: j.error,
      startedAt: new Date(j.started).toISOString(), endedAt: j.ended ? new Date(j.ended).toISOString() : null,
      durationMs: (j.ended ?? Date.now()) - j.started, timeoutSeconds: j.timeoutSeconds,
      totalLines: j.seq, droppedLines: j.dropped,
    }
  }

  /** Status plus the last `tail` lines (default 200, at most all kept). */
  describe(id: string, tail?: string | null): JobStatus & { lines: OutLine[] } {
    const j = this.get(id)
    let n = 200
    if (tail !== undefined && tail !== null && tail !== "") {
      n = Number(tail)
      if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "tail must be a whole number ≥ 0.")
    }
    return { ...this.status(j), lines: n === 0 ? [] : j.lines.slice(-n) }
  }

  list(): JobStatus[] {
    this.prune()
    return [...this.jobs.values()].sort((a, b) => b.started - a.started).map((j) => this.status(j))
  }

  /** Kept lines after `after` (a seq), then live events until the end; returns an unsubscribe. */
  subscribe(id: string, after: number, on: (e: JobEvent) => void): { lines: OutLine[]; skipped: number; ended: JobStatus | null; off: () => void } {
    const j = this.get(id)
    const lines = j.lines.filter((l) => l.seq > after)
    const firstKept = j.lines[0]?.seq ?? j.seq + 1
    const skipped = Math.max(0, firstKept - after - 1)
    if (j.state !== "running" && j.child === null) return { lines, skipped, ended: this.status(j), off: () => {} }
    j.listeners.add(on)
    return { lines, skipped, ended: null, off: () => j.listeners.delete(on) }
  }

  /** Stops a command and everything it started; resolves when it has ended. */
  async stop(id: string): Promise<JobStatus> {
    const j = this.get(id)
    if (j.state === "running") await this.terminate(j, "stopped")
    await Promise.race([j.exited, new Promise((r) => setTimeout(r, 3000))])
    return this.status(j)
  }

  /** On agent shutdown: TERM every running job's processes. */
  stopAll(): void {
    for (const j of this.jobs.values()) {
      if (j.state !== "running") continue
      for (const p of this.targets(j)) { try { process.kill(p.pid, "SIGTERM") } catch { /* gone */ } }
    }
  }

  // ---- internals --------------------------------------------------------

  private take(j: Job, stream: "stdout" | "stderr", d: string) {
    let buf = j.partial[stream] + d
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      this.push(j, stream, buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
    while (buf.length > MAX_LINE_CHARS) {
      this.push(j, stream, buf.slice(0, MAX_LINE_CHARS))
      buf = buf.slice(MAX_LINE_CHARS)
    }
    j.partial[stream] = buf
  }

  private flush(j: Job) {
    for (const s of ["stdout", "stderr"] as const) {
      if (j.partial[s] !== "") { this.push(j, s, j.partial[s]); j.partial[s] = "" }
    }
  }

  private push(j: Job, stream: "stdout" | "stderr", raw: string) {
    let text = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (!j.begun[stream] && text === BEGIN_MARK) { j.begun[stream] = true; return }
    if (text.length > MAX_LINE_CHARS) text = text.slice(0, MAX_LINE_CHARS) + "..."
    const line: OutLine = { seq: ++j.seq, t: Date.now(), stream, text }
    if (!j.begun[stream]) line.login = true
    j.lines.push(line)
    if (j.lines.length > this.maxLines) { j.lines.shift(); j.dropped++ }
    for (const l of j.listeners) l({ type: "line", line })
  }

  /** The job's processes now: descendants of the started process, and every process in their sessions. */
  private targets(j: Job): Proc[] {
    const procs = readProcs(this.procRoot)
    const kids = new Map<number, Proc[]>()
    for (const p of procs) {
      const a = kids.get(p.ppid)
      if (a) a.push(p); else kids.set(p.ppid, [p])
    }
    const found = new Map<number, Proc>()
    const top = procs.find((p) => p.pid === j.pid)
    const stack = top ? [top] : []
    while (stack.length) {
      const p = stack.pop()!
      if (found.has(p.pid)) continue
      found.set(p.pid, p)
      for (const c of kids.get(p.pid) ?? []) stack.push(c)
    }
    for (const p of found.values()) if (p.sid > 1 && p.sid !== this.selfSid) j.sids.add(p.sid)
    for (const p of procs) if (j.sids.has(p.sid)) found.set(p.pid, p)
    found.delete(process.pid)
    found.delete(1)
    return [...found.values()].filter((p) => p.state !== "Z" && p.state !== "X")
  }

  private alive(p: Proc): boolean {
    try {
      const now = parseStat(readFileSync(`${this.procRoot}/${p.pid}/stat`, "utf8"))
      return !!now && now.start === p.start && now.state !== "Z" && now.state !== "X"
    } catch { return false }
  }

  private terminate(j: Job, why: "stopped" | "timed_out" | null): Promise<void> {
    if (why && j.state === "running" && !j.wanted) j.wanted = why
    if (j.stopping) return j.stopping
    j.stopping = (async () => {
      const first = this.targets(j)
      if (first.length === 0) return
      for (const p of first) { try { process.kill(p.pid, "SIGTERM") } catch { /* gone */ } }
      const until = Date.now() + this.killGraceMs
      let left = first
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100))
        const fresh = this.targets(j)
        const seen = new Set(left.map((p) => p.pid))
        left = [...left.filter((p) => this.alive(p)), ...fresh.filter((p) => !seen.has(p.pid))]
        if (left.length === 0) return
      }
      for (const p of left) { try { process.kill(p.pid, "SIGKILL") } catch { /* gone */ } }
      // Anything started during the grace period.
      await new Promise((r) => setTimeout(r, 100))
      for (const p of this.targets(j)) { try { process.kill(p.pid, "SIGKILL") } catch { /* gone */ } }
    })().finally(() => { j.stopping = null })
    return j.stopping
  }

  // Learn each running job's sessions early (runuser starts one), so that
  // processes can still be found once the started process has ended.
  private ensureSampler() {
    if (this.sampler) return
    const tick = () => {
      const running = [...this.jobs.values()].filter((j) => j.state === "running")
      for (const j of running) this.targets(j)
      if (running.length === 0) { clearInterval(this.sampler!); this.sampler = null }
    }
    setTimeout(tick, 150).unref()
    this.sampler = setInterval(tick, 1000)
    this.sampler.unref()
  }

  private prune() {
    const now = Date.now()
    const ended = [...this.jobs.values()].filter((j) => j.state !== "running" && j.ended !== null)
    for (const j of ended) if (now - j.ended! > KEEP_ENDED_MS) this.jobs.delete(j.id)
    const rest = ended.filter((j) => this.jobs.has(j.id)).sort((a, b) => a.ended! - b.ended!)
    while (this.jobs.size > MAX_KEPT_JOBS && rest.length) this.jobs.delete(rest.shift()!.id)
  }
}

/** Checks at start that a command runs on the host as the user: `id -u` must print their uid. */
export function checkCommands(identity: HostIdentity, launcher: Launcher = hostLauncher, timeoutMs = 15000):
  Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
  if (!identity.ok) return Promise.resolve({ ok: false, error: identity.error })
  const t0 = Date.now()
  return new Promise((resolve) => {
    const { file, args } = launcher(identity.user, "id -u")
    let out = ""
    let err = ""
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } })
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout.on("data", (d) => { out += d })
    child.stderr.on("data", (d) => { if (err.length < 2000) err += d })
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }) })
    child.on("close", (code) => {
      clearTimeout(timer)
      const uid = out.trim().split("\n").pop()
      if (code === 0 && uid === String(identity.uid)) resolve({ ok: true, ms: Date.now() - t0 })
      else resolve({ ok: false, error: `exit ${code}; printed ${JSON.stringify(out.trim().slice(0, 200))}${err ? `; ${err.trim().slice(0, 300)}` : ""}` })
    })
  })
}
