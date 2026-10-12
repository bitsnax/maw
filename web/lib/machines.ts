import { randomUUID } from "node:crypto"
import { isIP } from "node:net"
import { prisma } from "./prisma"
import { getPki } from "./pki-store"
import { issueAgentCert } from "./pki"
import { callAgent, type AgentResult, type AgentTarget } from "./agent-client"

// Machines: pairing records and everything MAW asks of an agent.
//
// Not a "use server" file, so self-tests can call it directly. Server
// actions and pages that call it must check the session and role "admin"
// first (Machines are admin-only).

// ---- What agents answer (mirrors agent/src) -------------------------------

export type AgentInfo = {
  agent: { id: string; version: string; uptimeSeconds: number; runAs: string | null }
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

export async function recordAction(
  m: { id: string | null; name: string },
  userId: string | null,
  action: string,
  target: string | null,
  ok: boolean,
  message: string | null,
) {
  await prisma.machineAction.create({
    data: { machineId: m.id, machineName: m.name, userId, action, target, ok, message: message?.slice(0, 1000) ?? null },
  })
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
