import { randomUUID } from "node:crypto"
import { isIP } from "node:net"
import { prisma } from "./prisma"
import { getPki } from "./pki-store"
import { issueAgentCert } from "./pki"
import { callAgent, openAgentStream, type AgentResult, type AgentTarget } from "./agent-client"
import { AGENT_IMAGE, AGENT_VERSION, AGENT_DIR } from "./install-file"

// Machines: pairing records and everything MAW asks of an agent.
//
// Not a "use server" file, so self-tests can call it directly. Server
// actions and pages that call it must check the session and role "admin"
// first (Machines are admin-only).

// ---- What agents answer (mirrors agent/src) -------------------------------

export type AgentInfo = {
  agent: {
    id: string; version: string; uptimeSeconds: number; runAs: string | null
    // From agent 0.2.0 on:
    allowedBase?: string
    hostUser?: { ok: true; user: string; uid: number; gid: number; home: string; lang: string } | { ok: false; user: string; error: string }
    ripgrep?: string | null
    commands?: { ok: boolean; ms?: number; error?: string }
  }
  host: { hostname: string; os: string; kernel: string; cpus: number; memoryBytes: number }
  docker: { version: string; apiVersion: string; containers: number; running: number; stopped: number; paused: number } | null
  dockerError?: string
}

export type ContainerRow = {
  id: string; name: string; image: string; state: string; status: string
  created: string; project: string | null; service: string | null; self: boolean
}

export type ContainerActionName = "start" | "stop" | "restart"
export type ContainerActionResult = { id: string; name: string; action: ContainerActionName; changed: boolean; state: string }
export type LogLine = { time: string | null; stream: "stdout" | "stderr" | "tty"; text: string }
export type LogsResult = { id: string; name: string; state: string; tail: number; lines: LogLine[] }

type MachineRecord = AgentTarget & { id: string }

// ---- Pairing ---------------------------------------------------------------

export type NewMachineInput = { name: string; address: string; port: number; runAs: string }

export type InstallBundle = {
  machineId: string
  certPem: string
  keyPem: string // shown once in the install file; never stored
  caPem: string
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const HOST = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
const USER = /^[a-z_][a-z0-9_-]{0,31}$/

/** Checks the Add machine fields; returns readable messages per field. */
export function checkMachineInput(i: NewMachineInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!NAME.test(i.name)) errors.name = "Use lowercase letters, digits and dashes (for example caw-box)."
  if (!(isIP(i.address) || HOST.test(i.address))) errors.address = "Enter an IP address or a host name."
  if (!Number.isInteger(i.port) || i.port < 1 || i.port > 65535) errors.port = "Enter a port from 1 to 65535."
  if (!USER.test(i.runAs)) errors.runAs = "Enter the user name on that machine (for example bitsnax)."
  return errors
}

/** Creates the machine and its certificate. The key is returned for the
 *  install file only. */
export async function createMachine(
  input: NewMachineInput,
  userId: string | null,
): Promise<{ ok: true; machine: { id: string; name: string }; install: InstallBundle } | { ok: false; errors: Record<string, string> }> {
  const i = { ...input, name: input.name.trim(), address: input.address.trim(), runAs: input.runAs.trim() }
  const errors = checkMachineInput(i)
  if (Object.keys(errors).length) return { ok: false, errors }
  if (await prisma.machine.findUnique({ where: { name: i.name }, select: { id: true } })) {
    return { ok: false, errors: { name: `A machine named ${i.name} already exists.` } }
  }

  const pki = await getPki()
  const id = randomUUID()
  const cert = await issueAgentCert(pki.ca, id, i.address)
  try {
    const machine = await prisma.machine.create({
      data: {
        id, name: i.name, address: i.address, port: i.port, runAs: i.runAs,
        certFingerprint: cert.fingerprint, certNotAfter: cert.notAfter, createdById: userId,
      },
      select: { id: true, name: true },
    })
    await recordAction({ id, name: i.name }, userId, "machine.add", i.address, true, null)
    return { ok: true, machine, install: { machineId: id, certPem: cert.certPem, keyPem: cert.keyPem, caPem: pki.ca.certPem } }
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { ok: false, errors: { name: `A machine named ${i.name} already exists.` } }
    throw e
  }
}

// ---- Action record ---------------------------------------------------------

/** Records one action; returns the record's id. */
export async function recordAction(
  m: { id: string | null; name: string },
  userId: string | null,
  action: string,
  target: string | null,
  ok: boolean,
  message: string | null,
): Promise<string> {
  const row = await prisma.machineAction.create({
    data: { machineId: m.id, machineName: m.name, userId, action, target, ok, message: message?.slice(0, 1000) ?? null },
    select: { id: true },
  })
  return row.id
}

// ---- Calls to the agent ----------------------------------------------------

/** Agent and host summary; on success also updates last seen, version, host name. */
export async function getMachineInfo(m: MachineRecord): Promise<AgentResult<AgentInfo>> {
  const r = await callAgent<AgentInfo>(m, "GET", "/v1/info", { timeoutMs: 3_000 })
  if (r.ok) {
    await prisma.machine.update({
      where: { id: m.id },
      data: { lastSeenAt: new Date(), agentVersion: r.data.agent.version, hostname: r.data.host.hostname },
    })
  }
  return r
}

export async function getMachineContainers(m: MachineRecord): Promise<AgentResult<{ containers: ContainerRow[] }>> {
  return callAgent<{ containers: ContainerRow[] }>(m, "GET", "/v1/containers")
}

/** Start, stop or restart a container; every attempt is recorded. */
export async function runContainerAction(
  m: MachineRecord,
  userId: string | null,
  ref: string,
  action: ContainerActionName,
): Promise<AgentResult<ContainerActionResult>> {
  // Stop and restart wait up to 10 s for a clean exit, then Docker kills.
  const r = await callAgent<ContainerActionResult>(
    m, "POST", `/v1/containers/${encodeURIComponent(ref)}/${action}`, { timeoutMs: 45_000 })
  await recordAction(
    m, userId, `container.${action}`, ref, r.ok,
    r.ok ? (r.data.changed ? `now ${r.data.state}` : `already ${r.data.state}`) : r.message,
  )
  return r
}

export async function getContainerLogs(m: MachineRecord, ref: string, tail = 200): Promise<AgentResult<LogsResult>> {
  return callAgent<LogsResult>(m, "GET", `/v1/containers/${encodeURIComponent(ref)}/logs?tail=${tail}`, { timeoutMs: 20_000 })
}

// ---- Reissue and remove ------------------------------------------------------

/** New key and certificate for a machine. The stored fingerprint is replaced,
 *  so the old install file stops working the moment this returns. */
export async function reissueMachineCert(
  machineId: string,
  userId: string | null,
): Promise<{ ok: true; machine: { id: string; name: string; address: string; port: number; runAs: string }; install: InstallBundle } | { ok: false; message: string }> {
  const m = await prisma.machine.findUnique({ where: { id: machineId } })
  if (!m) return { ok: false, message: "This machine no longer exists." }
  const pki = await getPki()
  const cert = await issueAgentCert(pki.ca, m.id, m.address)
  await prisma.machine.update({
    where: { id: m.id },
    data: { certFingerprint: cert.fingerprint, certNotAfter: cert.notAfter },
  })
  await recordAction(m, userId, "machine.reissue", m.address, true, "new certificate; the previous install file no longer works")
  return {
    ok: true,
    machine: { id: m.id, name: m.name, address: m.address, port: m.port, runAs: m.runAs },
    install: { machineId: m.id, certPem: cert.certPem, keyPem: cert.keyPem, caPem: pki.ca.certPem },
  }
}

/** Removes the machine from MAW. Its action records stay (machine name kept);
 *  the agent keeps running on the machine until it is stopped there. */
export async function removeMachine(machineId: string, userId: string | null): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const m = await prisma.machine.findUnique({ where: { id: machineId } })
  if (!m) return { ok: false, message: "This machine no longer exists." }
  const projects = await prisma.project.findMany({ where: { machineId: m.id }, select: { name: true }, orderBy: { name: "asc" } })
  if (projects.length) {
    return { ok: false, message: `${m.name} still has project${projects.length === 1 ? "" : "s"} ${projects.map((p) => p.name).join(", ")}. Remove ${projects.length === 1 ? "it" : "them"} first (Projects).` }
  }
  await recordAction(m, userId, "machine.remove", m.address, true, "removed from MAW; MAW no longer accepts its agent")
  await prisma.machine.deleteMany({ where: { id: m.id } })
  return { ok: true, name: m.name }
}

// ---- Agent version -----------------------------------------------------------

/** "0.1.0" < "0.2.0": numeric compare of dotted versions. */
export function versionBelow(v: string, than: string): boolean {
  const a = v.split(".").map((x) => Number.parseInt(x, 10) || 0)
  const b = than.split(".").map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}

export type AgentUpdate = { current: string; expected: string; steps: { where: string; command: string }[] }

/** The update steps when a machine's agent is older than this MAW expects; else null.
 *  The image is copied from the GPU box (where MAW builds it), then the
 *  machine's compose file is pointed at the new tag and restarted; its
 *  certificate and key stay as they are. */
export function agentUpdate(m: { name: string; address: string; runAs: string }, version: string | null | undefined): AgentUpdate | null {
  if (!version || !versionBelow(version, AGENT_VERSION)) return null
  return {
    current: version,
    expected: AGENT_VERSION,
    steps: [
      { where: "On the GPU box (192.168.4.201), where MAW builds the image; skip if this is that machine",
        command: `docker save ${AGENT_IMAGE} | ssh ${m.address} docker load` },
      { where: `On ${m.name}`,
        command: `cd ${AGENT_DIR} && sed -i 's#image: maw-agent:[0-9.]*#image: ${AGENT_IMAGE}#' compose.yaml && docker compose up -d` },
    ],
  }
}

// ---- Files (agent 0.2.0) -------------------------------------------------------
//
// Every call names a project root (inside /opt on the machine) and a path
// inside it. Reads, lists and searches are not recorded; writes and edits
// are (path, and the outcome).

export type FileRead = { path: string; content: string; offset: number; lines: number; totalLines: number; more: boolean }
export type DirEntry = {
  name: string; type: "file" | "dir" | "link" | "other"; target?: "file" | "dir" | "other" | "broken"
  size: number; modified: string
}
export type DirList = { path: string; entries: DirEntry[]; truncated: boolean }
export type FileWrite = { path: string; created: boolean; bytes: number }
export type FileEdit = { path: string; replacements: number }
export type GlobResult = { path: string; files: string[]; truncated: boolean }
export type SearchMatch = { file: string; line: number; text: string }
export type SearchResult = { path: string; matches: SearchMatch[]; truncated: boolean }

/** root + path as one readable string for the action record. */
function where(root: string, path: string): string {
  if (path.startsWith("/")) return path
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`
}

export function readMachineFile(m: MachineRecord, root: string, path: string, offset?: number, limit?: number) {
  return callAgent<FileRead>(m, "POST", "/v1/fs/read", { body: { root, path, offset, limit }, timeoutMs: 20_000 })
}

export function listMachineDir(m: MachineRecord, root: string, path = ".") {
  return callAgent<DirList>(m, "POST", "/v1/fs/list", { body: { root, path }, timeoutMs: 20_000 })
}

export async function writeMachineFile(m: MachineRecord, userId: string | null, root: string, path: string, content: string) {
  const r = await callAgent<FileWrite>(m, "POST", "/v1/fs/write", { body: { root, path, content }, timeoutMs: 30_000 })
  await recordAction(m, userId, "file.write", where(root, path), r.ok,
    r.ok ? `${r.data.created ? "created" : "replaced"} · ${r.data.bytes} bytes` : r.message)
  return r
}

export async function editMachineFile(
  m: MachineRecord, userId: string | null, root: string, path: string,
  oldString: string, newString: string, replaceAll = false,
) {
  const r = await callAgent<FileEdit>(m, "POST", "/v1/fs/edit", { body: { root, path, oldString, newString, replaceAll }, timeoutMs: 30_000 })
  await recordAction(m, userId, "file.edit", where(root, path), r.ok,
    r.ok ? `${r.data.replacements} replacement${r.data.replacements === 1 ? "" : "s"}` : r.message)
  return r
}

export function globMachineFiles(m: MachineRecord, root: string, pattern: string, path?: string, limit?: number) {
  return callAgent<GlobResult>(m, "POST", "/v1/fs/glob", { body: { root, pattern, path, limit }, timeoutMs: 30_000 })
}

export function searchMachineFiles(
  m: MachineRecord, root: string, pattern: string,
  opts: { path?: string; include?: string; ignoreCase?: boolean; limit?: number } = {},
) {
  return callAgent<SearchResult>(m, "POST", "/v1/fs/search", { body: { root, pattern, ...opts }, timeoutMs: 30_000 })
}

// ---- Commands (agent 0.2.0) ----------------------------------------------------
//
// A command runs on the machine as its run-as user (login shell, in the
// root). It is recorded when it starts (action "command", target = the
// command text, message "running · <root> · job <id>"), and the same record
// is completed with the outcome when MAW next sees the job end: through the
// stream, a status call, Stop, or reconcileCommandRecords (machine page).

export type CommandState = "running" | "exited" | "stopped" | "timed_out" | "failed"
export type OutputLine = { seq: number; t: number; stream: "stdout" | "stderr"; text: string; login?: true }
export type CommandStatus = {
  id: string; root: string; command: string; state: CommandState
  exitCode: number | null; signal: string | null; error: string | null
  startedAt: string; endedAt: string | null; durationMs: number; timeoutSeconds: number
  totalLines: number; droppedLines: number
}
export type CommandDetail = CommandStatus & { lines: OutputLine[] }

const JOB = /^[0-9a-f]{16}$/
const jobTag = (jobId: string) => `job ${jobId}`

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`
}

/** The record's outcome for a finished job: [ok, message]. */
export function commandOutcome(s: CommandStatus): [boolean, string] {
  const tail = `${s.root} · ${jobTag(s.id)}`
  switch (s.state) {
    case "exited": return [s.exitCode === 0, `exit ${s.exitCode} in ${seconds(s.durationMs)} · ${tail}`]
    case "stopped": return [true, `stopped after ${seconds(s.durationMs)} · ${tail}`]
    case "timed_out": return [false, `timed out after ${s.timeoutSeconds} s · ${tail}`]
    case "failed": return [false, `could not start: ${s.error ?? "unknown error"} · ${tail}`]
    default: return [true, `running · ${tail}`]
  }
}

/** Completes the command's record once (only while it still says running). */
export async function finishCommandRecord(machineId: string, s: CommandStatus): Promise<boolean> {
  if (s.state === "running") return false
  const [ok, message] = commandOutcome(s)
  const r = await prisma.machineAction.updateMany({
    where: { machineId, action: "command", message: { startsWith: "running · ", endsWith: ` · ${jobTag(s.id)}` } },
    data: { ok, message },
  })
  return r.count > 0
}

export async function startMachineCommand(
  m: MachineRecord, userId: string | null, root: string, command: string, timeoutSeconds?: number,
): Promise<AgentResult<CommandStatus & { jobId: string }>> {
  const r = await callAgent<CommandStatus & { jobId: string }>(m, "POST", "/v1/exec", {
    body: { root, command, timeoutSeconds }, timeoutMs: 20_000,
  })
  await recordAction(m, userId, "command", command.slice(0, 4000), r.ok,
    r.ok ? `running · ${r.data.root} · ${jobTag(r.data.jobId)}` : r.message)
  return r
}

/** Status and the last `tail` lines; completes the record if it has ended. */
export async function getMachineCommand(m: MachineRecord, jobId: string, tail = 200): Promise<AgentResult<CommandDetail>> {
  if (!JOB.test(jobId)) return { ok: false, status: 400, message: "Not a command id." }
  const r = await callAgent<CommandDetail>(m, "GET", `/v1/exec/${jobId}?tail=${Math.max(0, Math.floor(tail))}`)
  if (r.ok) await finishCommandRecord(m.id, r.data)
  return r
}

/** Stops the command and everything it started; returns when it has ended (≤ ~10 s). */
export async function stopMachineCommand(m: MachineRecord, jobId: string): Promise<AgentResult<CommandStatus>> {
  if (!JOB.test(jobId)) return { ok: false, status: 400, message: "Not a command id." }
  const r = await callAgent<CommandStatus>(m, "POST", `/v1/exec/${jobId}/stop`, { timeoutMs: 20_000 })
  if (r.ok) await finishCommandRecord(m.id, r.data)
  return r
}

export function listMachineCommands(m: MachineRecord) {
  return callAgent<{ jobs: CommandStatus[] }>(m, "GET", "/v1/exec")
}

/** Completes records still marked running whose job has ended, or that the
 *  agent no longer knows (restarted, or ended over an hour ago). */
export async function reconcileCommandRecords(m: MachineRecord): Promise<number> {
  const open = await prisma.machineAction.findMany({
    where: { machineId: m.id, action: "command", message: { startsWith: "running · " } },
    select: { id: true, message: true },
  })
  let done = 0
  for (const a of open) {
    const jobId = / · job ([0-9a-f]{16})$/.exec(a.message ?? "")?.[1]
    if (!jobId) continue
    const r = await callAgent<CommandDetail>(m, "GET", `/v1/exec/${jobId}?tail=0`, { timeoutMs: 5_000 })
    if (r.ok) {
      if (await finishCommandRecord(m.id, r.data)) done++
    } else if (r.status === 404) {
      const root = / · (.*) · job /.exec(a.message ?? "")?.[1] ?? ""
      await prisma.machineAction.updateMany({
        where: { id: a.id, message: { startsWith: "running · " } },
        data: { ok: false, message: `outcome unknown (the agent no longer has this command) · ${root} · ${jobTag(jobId)}` },
      })
      done++
    }
  }
  return done
}

/**
 * The command's output for a browser: the agent's NDJSON stream passed
 * through line by line (after `after`, a line number), ending with its
 * {"type":"end", ...status} line; the record is completed when the end
 * passes. If the agent's stream breaks off, a last
 * {"type":"error","message"} line says so. Cancelling the returned stream
 * (the browser left) closes the connection to the agent.
 */
export async function streamMachineCommand(
  m: MachineRecord, jobId: string, after = 0, signal?: AbortSignal,
): Promise<AgentResult<ReadableStream<Uint8Array>>> {
  if (!JOB.test(jobId)) return { ok: false, status: 400, message: "Not a command id." }
  const n = Number.isInteger(after) && after >= 0 ? after : 0
  const opened = await openAgentStream(m, `/v1/exec/${jobId}/stream?after=${n}`, { signal })
  if (!opened.ok) return opened
  const res = opened.data
  const enc = new TextEncoder()
  let buf = ""
  let ended = false
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        try { controller.close() } catch { /* already closed */ }
      }
      const out = (line: string) => { if (!closed) controller.enqueue(enc.encode(line + "\n")) }
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        buf += chunk
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          out(line)
          try {
            const e = JSON.parse(line) as { type?: string } & CommandStatus
            if (e.type === "end") {
              ended = true
              void finishCommandRecord(m.id, e).catch(() => { /* recorded later by reconcile */ })
            }
          } catch { /* passed through as is */ }
        }
      })
      const finish = () => {
        if (!ended && !closed) out(JSON.stringify({ type: "error", message: `The connection to ${m.name} ended before the command did. Its status is still available.` }))
        close()
      }
      res.on("end", finish)
      res.on("close", finish)
      res.on("error", finish)
    },
    cancel() {
      closed = true
      res.destroy()
    },
  })
  return { ok: true, data: stream }
}
