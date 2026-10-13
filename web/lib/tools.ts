import path from "node:path"
import { STORY_TOOL_NAMES, StoryToolError, dockerWrites, gitWrites, handleStoryTool, jobOf, type StoryToolName } from "./story-tools"
import { timingSafeEqual } from "node:crypto"
import { prisma } from "./prisma"
import {
  readMachineFile, listMachineDir, writeMachineFile, editMachineFile, globMachineFiles, searchMachineFiles,
  startMachineCommand, streamMachineCommand, stopMachineCommand, getMachineCommand, type CommandStatus,
} from "./machines"
import { shq } from "./shell"

// OpenCode's file and command tools, forwarded to the project's machine.
//
// maw-opencode replaces OpenCode's built-in read, write, edit, glob, grep and
// bash with thin tools that POST here (/api/tools/<name>) with a token. Each
// call names the session's workspace folder (/workspaces/<project slug>);
// MAW finds the project, translates paths to the project's folder on its
// machine, calls the agent (Phase 2), records writes, edits and commands,
// and answers in the same shape as OpenCode 1.19's built-in tool, so the
// model sees what it was trained on.
//
// Request:  POST /api/tools/<tool>  Authorization: Bearer <MAW_TOOLS_TOKEN>
//           {"sessionID": "...", "directory": "/workspaces/<slug>", "args": {...}}
// Answer:   {"ok": true, "output": "...", "title": "...", "metadata": {...}}
//           {"ok": false, "message": "..."}   (the tool turns it into an error)
// bash answers NDJSON instead (see runBash).

export const WORKSPACES = "/workspaces"
export const TOOL_NAMES = ["read", "write", "edit", "glob", "grep", "bash", ...STORY_TOOL_NAMES] as const
export type ToolName = (typeof TOOL_NAMES)[number]

const READ_LIMIT = 2000
const LIST_LIMIT = 100
const SEARCH_LIMIT = 100
const BASH_MAX_LINES = 2000
const BASH_MAX_BYTES = 51200
const BASH_DEFAULT_MS = 120_000
const BASH_MAX_MS = 3_600_000
const MAX_BODY_BYTES = 6 * 1024 * 1024
// What runuser itself prints when the agent stops a command (Stop, time
// limit, abort); not the command's output, and OpenCode's bash never shows it.
const RUNUSER_NOTICE = /^(Session terminated, killing shell\.\.\.)? ?(\.\.\.killed\.)?$/

export class ToolError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export type ToolResult = { output: string; title?: string; metadata?: Record<string, unknown> }

type Project = NonNullable<Awaited<ReturnType<typeof findProject>>>
export type ToolContext = { project: Project; userId: string | null; sessionID: string; workspace: string }

function findProject(slug: string) {
  return prisma.project.findUnique({ where: { slug }, include: { machine: true } })
}

// ---- context and paths -----------------------------------------------------------

/** The project for a workspace folder, and the user who started the session. */
export async function toolContext(directory: unknown, sessionID: unknown): Promise<ToolContext> {
  if (typeof directory !== "string" || !directory.startsWith(WORKSPACES + "/")) {
    throw new ToolError(400, `The session's folder ${String(directory)} is not a MAW workspace (${WORKSPACES}/<project>).`)
  }
  const slug = directory.slice(WORKSPACES.length + 1).split("/")[0] ?? ""
  const project = slug ? await findProject(slug) : null
  if (!project) throw new ToolError(404, `No MAW project has the workspace ${WORKSPACES}/${slug}.`)
  const sid = typeof sessionID === "string" ? sessionID : ""
  let userId: string | null = null
  if (sid) {
    const s = await prisma.projectSession.findUnique({ where: { id: sid }, select: { projectId: true, userId: true } })
    if (s && s.projectId !== project.id) throw new ToolError(400, `Session ${sid} belongs to another project.`)
    userId = s?.userId ?? null
  }
  return { project, userId, sessionID: sid, workspace: `${WORKSPACES}/${project.slug}` }
}

/**
 * A path as the model gives it, as the absolute path on the machine. Accepted:
 * relative (to the project folder), inside the workspace (/workspaces/<slug>/x),
 * or inside the project folder itself (/opt/caw/x). Anything else is refused.
 */
export function mapPath(ctx: Pick<ToolContext, "workspace"> & { project: { root: string; machine: { name: string } } }, p: unknown): string {
  const root = ctx.project.root
  if (p === undefined || p === null || p === "") return root
  if (typeof p !== "string") throw new ToolError(400, "A path must be a string.")
  if (p.includes("\0")) throw new ToolError(400, "A path cannot contain a NUL character.")
  let abs: string
  if (p === ctx.workspace || p.startsWith(ctx.workspace + "/")) abs = root + p.slice(ctx.workspace.length)
  else if (path.posix.isAbsolute(p)) abs = p
  else abs = path.posix.join(root, p)
  abs = path.posix.normalize(abs)
  if (abs.length > 1) abs = abs.replace(/\/+$/, "")
  if (abs !== root && !abs.startsWith(root + "/")) {
    throw new ToolError(400, `${p} is outside the project folder ${root} on ${ctx.project.machine.name}. Use paths inside ${root}.`)
  }
  return abs
}

const relTitle = (ctx: ToolContext, abs: string) => path.posix.relative(ctx.project.root, abs) || "."

// ---- the tools ---------------------------------------------------------------------

type Args = Record<string, unknown>

function str(a: Args, k: string, required = true): string | undefined {
  const v = a[k]
  if (v === undefined || v === null) {
    if (required) throw new ToolError(400, `${k} is required.`)
    return undefined
  }
  if (typeof v !== "string") throw new ToolError(400, `${k} must be a string.`)
  return v
}
function int(a: Args, k: string, min: number): number | undefined {
  const v = a[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new ToolError(400, `${k} must be a whole number ≥ ${min}.`)
  return v
}

async function readTool(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const abs = mapPath(ctx, str(a, "filePath"))
  const offset = int(a, "offset", 0) ?? 1
  const limit = int(a, "limit", 0) || READ_LIMIT
  const m = ctx.project.machine
  const r = await readMachineFile(m, ctx.project.root, abs, Math.max(offset, 1) - 1, limit)
  if (!r.ok) {
    if (r.status === 400 && / is a folder\.$/.test(r.message)) return readDirectory(ctx, abs)
    if (r.status === 404) throw new ToolError(404, `File not found: ${abs}`)
    if (r.status === 415) throw new ToolError(415, `Cannot read binary file: ${abs}`)
    if (r.status === 400 && /past the end/.test(r.message)) {
      const total = /\((\d+) lines\)/.exec(r.message)?.[1] ?? "?"
      throw new ToolError(400, `Offset ${offset} is out of range for this file (${total} lines)`)
    }
    throw new ToolError(r.status ?? 502, r.message)
  }
  const lines = r.data.content === "" ? [] : r.data.content.split("\n").map((l) => {
    const bar = l.indexOf("| ")
    return `${Number(l.slice(0, bar))}: ${l.slice(bar + 2)}`
  })
  const first = r.data.offset + 1
  const last = r.data.offset + r.data.lines
  const footer = r.data.more
    ? `(Showing lines ${first}-${last} of ${r.data.totalLines}. Use offset=${last + 1} to continue.)`
    : `(End of file - total ${r.data.totalLines} lines)`
  const output = [`<path>${abs}</path>`, "<type>file</type>", "<content>", ...lines, "", footer, "</content>"].join("\n")
  return { output, title: relTitle(ctx, abs), metadata: { truncated: r.data.more } }
}

async function readDirectory(ctx: ToolContext, abs: string): Promise<ToolResult> {
  const l = await listMachineDir(ctx.project.machine, ctx.project.root, abs)
  if (!l.ok) throw new ToolError(l.status ?? 502, l.message)
  const names = l.data.entries
    .map((e) => (e.type === "dir" || e.target === "dir" ? `${e.name}/` : e.name))
    .sort((x, y) => x.localeCompare(y))
  const output = [`<path>${abs}</path>`, "<type>directory</type>", "<entries>", ...names, "",
    `(${names.length} entries)`, "</entries>"].join("\n")
  return { output, title: relTitle(ctx, abs), metadata: { truncated: l.data.truncated } }
}

async function writeTool(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const abs = mapPath(ctx, str(a, "filePath"))
  const content = str(a, "content") ?? ""
  const r = await writeMachineFile(ctx.project.machine, ctx.userId, ctx.project.root, abs, content)
  if (!r.ok) throw new ToolError(r.status ?? 502, r.message)
  return { output: "Wrote file successfully.", title: relTitle(ctx, abs), metadata: { filepath: abs, exists: !r.data.created } }
}

async function editTool(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const abs = mapPath(ctx, str(a, "filePath"))
  const oldString = str(a, "oldString") ?? ""
  const newString = str(a, "newString") ?? ""
  if (oldString === newString) throw new ToolError(400, "No changes to apply: oldString and newString are identical.")
  // As OpenCode's edit: an empty oldString writes newString as the whole file.
  if (oldString === "") {
    const w = await writeMachineFile(ctx.project.machine, ctx.userId, ctx.project.root, abs, newString)
    if (!w.ok) throw new ToolError(w.status ?? 502, w.message)
    return { output: "Edit applied successfully.", title: relTitle(ctx, abs), metadata: { filepath: abs } }
  }
  const r = await editMachineFile(ctx.project.machine, ctx.userId, ctx.project.root, abs, oldString, newString, a.replaceAll === true)
  if (!r.ok) {
    if (r.status === 422 && /was not found/.test(r.message)) {
      throw new ToolError(422, "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.")
    }
    if (r.status === 422 && /was found \d+ times/.test(r.message)) {
      throw new ToolError(422, "Found multiple matches for oldString. Provide more surrounding context to make the match unique.")
    }
    if (r.status === 404) throw new ToolError(404, `File not found: ${abs}`)
    throw new ToolError(r.status ?? 502, r.message)
  }
  return { output: "Edit applied successfully.", title: relTitle(ctx, abs), metadata: { filepath: abs, replacements: r.data.replacements } }
}

async function globTool(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const pattern = str(a, "pattern") ?? ""
  const dir = mapPath(ctx, str(a, "path", false))
  const r = await globMachineFiles(ctx.project.machine, ctx.project.root, pattern, dir, LIST_LIMIT)
  if (!r.ok) throw new ToolError(r.status ?? 502, r.message)
  const files = r.data.files.map((f) => path.posix.join(ctx.project.root, f))
  if (files.length === 0) return { output: "No files found", title: relTitle(ctx, dir), metadata: { count: 0, truncated: false } }
  const out = [...files]
  if (r.data.truncated) out.push("", `(Results are truncated: showing first ${LIST_LIMIT} results. Consider using a more specific path or pattern.)`)
  return { output: out.join("\n"), title: relTitle(ctx, dir), metadata: { count: files.length, truncated: r.data.truncated } }
}

async function grepTool(ctx: ToolContext, a: Args): Promise<ToolResult> {
  const pattern = str(a, "pattern") ?? ""
  const dir = mapPath(ctx, str(a, "path", false))
  const include = str(a, "include", false) || undefined
  const r = await searchMachineFiles(ctx.project.machine, ctx.project.root, pattern, { path: dir, include, limit: SEARCH_LIMIT })
  if (!r.ok) throw new ToolError(r.status ?? 502, r.message)
  const ms = r.data.matches
  if (ms.length === 0) return { output: "No files found", title: pattern, metadata: { matches: 0, truncated: false } }
  const groups = new Map<string, string[]>()
  for (const m of ms) {
    const f = path.posix.join(ctx.project.root, m.file)
    const g = groups.get(f) ?? []
    g.push(`  Line ${m.line}: ${m.text}`)
    groups.set(f, g)
  }
  const out = [`Found ${ms.length} matches${r.data.truncated ? " (more matches available)" : ""}`]
  for (const [f, lines] of groups) out.push(`${f}:`, ...lines, "")
  if (r.data.truncated) out.push("(Results truncated. Consider using a more specific path or pattern.)")
  return { output: out.join("\n").replace(/\n+$/, "\n"), title: pattern, metadata: { matches: ms.length, truncated: r.data.truncated } }
}

// ---- bash (streamed) ------------------------------------------------------------------

/** Keeps the last lines of a command's output within OpenCode's limits (2,000 lines, 50 KB). */
export class OutputTail {
  private lines: string[] = []
  private bytes = 0
  truncated = false
  push(text: string) {
    this.lines.push(text)
    this.bytes += Buffer.byteLength(text) + 1
    while (this.lines.length > BASH_MAX_LINES || (this.bytes > BASH_MAX_BYTES && this.lines.length > 1)) {
      this.bytes -= Buffer.byteLength(this.lines.shift()!) + 1
      this.truncated = true
    }
  }
  text(): string {
    return this.lines.join("\n")
  }
}

export function bashOutput(tail: OutputTail, s: Pick<CommandStatus, "state" | "exitCode" | "error">, timeoutMs: number): string {
  let out = tail.text()
  if (tail.truncated) out = `...output truncated...\n\n${out}`
  if (out === "" && s.state === "exited") out = "(no output)"
  // A stopped command's shell leaves an empty line behind; OpenCode's note follows the last real line.
  if (s.state === "timed_out" || s.state === "stopped") out = out.replace(/\n+$/, "")
  if (s.state === "timed_out") {
    out += `\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout ${timeoutMs} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.\n</shell_metadata>`
  } else if (s.state === "stopped") {
    out += "\n\n<shell_metadata>\nThe command was stopped before it finished.\n</shell_metadata>"
  }
  return out
}

/**
 * Runs the command on the machine and answers NDJSON, one event per line:
 *   {"type":"start","jobId","title"}
 *   {"type":"line","stream","text"}             as the command prints (login lines left out)
 *   {"type":"result","output","title","metadata":{"exit","state","truncated"}}
 *   {"type":"error","message"}                  the command could not be run or followed
 * If the caller goes away (OpenCode aborted the tool), the command is stopped.
 */
async function runBash(ctx: ToolContext, a: Args, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const command = str(a, "command") ?? ""
  if (!command.trim()) throw new ToolError(400, "command is required.")
  // In a session MAW runs for a story, git that changes state is the
  // developer's: refused before anything runs.
  const writes = ctx.sessionID ? gitWrites(command) : []
  if (writes.length && (await jobOf(ctx.sessionID))) {
    throw new ToolError(403, `Refused: \`git ${writes.join("`, `git ")}\` changes the repository, and in story sessions git that changes state is the developer's (branch, commit, push, merge, …). Read-only git (status, diff, log, show) is fine. Leave the change in the working tree and say what should be committed.`)
  }
  // Deploys are MAW's too: it runs the project's deploy command after a verified step.
  const docker = ctx.sessionID ? dockerWrites(command) : []
  if (docker.length && (await jobOf(ctx.sessionID))) {
    throw new ToolError(403, `Refused: \`${docker.join("`, `")}\` changes what runs. In story sessions MAW deploys the project itself (its deploy command, after the verify commands pass). Read-only docker (ps, logs, inspect) is fine.`)
  }
  const timeoutMs = Math.min(Math.max(int(a, "timeout", 1) ?? BASH_DEFAULT_MS, 1000), BASH_MAX_MS)
  const workdir = a.workdir === undefined || a.workdir === null || a.workdir === "" ? null : mapPath(ctx, str(a, "workdir"))
  const script = workdir && workdir !== ctx.project.root ? `cd ${shq(workdir)} || exit 1\n${command}` : command
  const m = ctx.project.machine

  const started = await startMachineCommand(m, ctx.userId, ctx.project.root, script, Math.ceil(timeoutMs / 1000))
  if (!started.ok) throw new ToolError(started.status ?? 502, started.message)
  const jobId = started.data.jobId
  const title = command.length > 200 ? command.slice(0, 199) + "…" : command
  const enc = new TextEncoder()
  let finished = false
  const stopJob = () => { if (!finished) { finished = true; void stopMachineCommand(m, jobId).catch(() => {}) } }
  signal.addEventListener("abort", stopJob, { once: true })

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const emit = (o: unknown) => { if (open) { try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")) } catch { open = false } } }
      emit({ type: "start", jobId, title })
      const tail = new OutputTail()
      let end: CommandStatus | null = null
      try {
        const st = await streamMachineCommand(m, jobId, 0, signal)
        if (!st.ok) throw new Error(st.message)
        const reader = st.data.getReader()
        const dec = new TextDecoder()
        let buf = ""
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf("\n")) >= 0) {
            const raw = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            if (!raw.trim()) continue
            const e = JSON.parse(raw) as { type: string; stream?: string; text?: string; login?: boolean } & CommandStatus
            if (e.type === "line" && !e.login && !(e.stream === "stderr" && e.text && RUNUSER_NOTICE.test(e.text))) {
              tail.push(e.text ?? "")
              emit({ type: "line", stream: e.stream, text: e.text })
            }
            else if (e.type === "end") end = e
          }
        }
        // The stream broke off before the end: ask for the status (and the kept lines).
        if (!end && !signal.aborted) {
          const s = await getMachineCommand(m, jobId, BASH_MAX_LINES)
          if (s.ok && s.data.state !== "running") end = s.data
        }
        if (end) {
          finished = true
          emit({
            type: "result", title,
            output: bashOutput(tail, end, timeoutMs),
            metadata: { exit: end.exitCode, state: end.state, truncated: tail.truncated, description: title },
          })
        } else if (!signal.aborted) {
          emit({ type: "error", message: `Lost the connection to ${m.name} while the command was running; it may still be running there.` })
        }
      } catch (e) {
        if (!signal.aborted) emit({ type: "error", message: e instanceof Error ? e.message : String(e) })
      } finally {
        open = false
        try { controller.close() } catch { /* closed */ }
      }
    },
    cancel() { stopJob() },
  })
}

// ---- the HTTP side -------------------------------------------------------------------------

function tokenOk(header: string | null): "ok" | "unset" | "bad" {
  const want = process.env.MAW_TOOLS_TOKEN ?? ""
  if (want.length < 32) return "unset"
  const got = header?.startsWith("Bearer ") ? header.slice(7) : ""
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "bad"
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } })

/** The whole route: token, body, project, then the tool. */
export async function handleToolRequest(tool: string, req: Request): Promise<Response> {
  const auth = tokenOk(req.headers.get("authorization"))
  if (auth === "unset") return json(503, { ok: false, message: "MAW_TOOLS_TOKEN is not set (at least 32 characters) in MAW's .env." })
  if (auth === "bad") return json(401, { ok: false, message: "Wrong or missing tools token." })
  if (!(TOOL_NAMES as readonly string[]).includes(tool)) return json(404, { ok: false, message: `No tool ${tool}.` })

  let body: { sessionID?: unknown; directory?: unknown; args?: unknown }
  try {
    const text = await req.text()
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return json(413, { ok: false, message: "The request is over 6 MB." })
    body = JSON.parse(text) as typeof body
    if (!body || typeof body !== "object") throw new Error()
  } catch {
    return json(400, { ok: false, message: "The request must be a JSON object." })
  }
  const args = (body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {}) as Args

  try {
    const ctx = await toolContext(body.directory, body.sessionID)
    if ((STORY_TOOL_NAMES as readonly string[]).includes(tool)) {
      const job = await jobOf(ctx.sessionID)
      if (job) {
        const story = await prisma.story.findUnique({ where: { id: job.storyId }, select: { projectId: true } })
        if (story && story.projectId !== ctx.project.id) throw new ToolError(400, "This session's story belongs to another project.")
      }
      const r = await handleStoryTool(tool as StoryToolName, ctx.sessionID, args)
      return json(200, { ok: true, ...r })
    }
    if (tool === "bash") {
      const stream = await runBash(ctx, args, req.signal)
      return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } })
    }
    // Story planning sessions read the project; only a step session changes it.
    if ((tool === "write" || tool === "edit") && ctx.sessionID) {
      const job = await jobOf(ctx.sessionID)
      if (job && job.kind !== "step") throw new ToolError(403, `Refused: this is a planning session (${job.kind}); it reads the project and records what it finds with the story tools. Files are changed only in step sessions.`)
    }
    const run = { read: readTool, write: writeTool, edit: editTool, glob: globTool, grep: grepTool }[tool as "read" | "write" | "edit" | "glob" | "grep"]
    const r = await run(ctx, args)
    return json(200, { ok: true, ...r })
  } catch (e) {
    if (e instanceof ToolError || e instanceof StoryToolError) return json(e.status >= 400 && e.status < 600 ? e.status : 500, { ok: false, message: e.message })
    return json(500, { ok: false, message: e instanceof Error ? e.message : String(e) })
  }
}
