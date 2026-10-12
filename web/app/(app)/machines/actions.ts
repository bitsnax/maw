"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import {
  createMachine, runContainerAction, getContainerLogs, reissueMachineCert, removeMachine,
  listMachineDir, readMachineFile, searchMachineFiles, globMachineFiles,
  startMachineCommand, getMachineCommand, stopMachineCommand, listMachineCommands,
  type ContainerActionName, type ContainerActionResult, type LogsResult,
  type DirList, type FileRead, type SearchResult, type GlobResult, type CommandStatus, type CommandDetail,
} from "@/lib/machines"
import { installFile, AGENT_DIR, AGENT_IMAGE } from "@/lib/install-file"
import { REMOVE_PHRASE } from "./phrases"

export type AddMachineState =
  | { status: "idle" }
  | { status: "error"; message?: string; errors: Record<string, string>; values: Record<string, string> }
  | { status: "done"; name: string; address: string; yaml: string; dir: string; image: string }

// Returns a state for the form instead of throwing, so a problem shows as a
// readable message rather than Next's generic production error.
export async function addMachine(_prev: AddMachineState, form: FormData): Promise<AddMachineState> {
  const values = {
    name: String(form.get("name") ?? "").trim(),
    address: String(form.get("address") ?? "").trim(),
    port: String(form.get("port") ?? "7017").trim(),
    runAs: String(form.get("runAs") ?? "").trim(),
  }
  const session = await adminSession()
  if (!session) return { status: "error", message: "Only an admin can add machines.", errors: {}, values }

  try {
    const r = await createMachine(
      { name: values.name, address: values.address, port: Number(values.port), runAs: values.runAs },
      session.user.id,
    )
    if (!r.ok) return { status: "error", errors: r.errors, values }
    revalidatePath("/machines")
    return {
      status: "done",
      name: values.name,
      address: values.address,
      yaml: installFile({ name: values.name, address: values.address, port: Number(values.port), runAs: values.runAs }, r.install),
      dir: AGENT_DIR,
      image: AGENT_IMAGE,
    }
  } catch (e) {
    return { status: "error", message: `The machine was not added: ${e instanceof Error ? e.message : String(e)}`, errors: {}, values }
  }
}

// ---- Machine page ----------------------------------------------------------

export type ActionReply<T> = { ok: true; data: T } | { ok: false; message: string }

async function machineFor(id: string) {
  return prisma.machine.findUnique({ where: { id } })
}

export async function containerAction(
  machineId: string,
  ref: string,
  action: ContainerActionName,
): Promise<ActionReply<ContainerActionResult>> {
  const session = await adminSession()
  if (!session) return { ok: false, message: "Only an admin can control containers." }
  if (!["start", "stop", "restart"].includes(action)) return { ok: false, message: "Unknown action." }
  const m = await machineFor(machineId)
  if (!m) return { ok: false, message: "This machine no longer exists." }
  try {
    const r = await runContainerAction(m, session.user.id, ref, action)
    revalidatePath(`/machines/${machineId}`)
    return r.ok ? { ok: true, data: r.data } : { ok: false, message: r.message }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

export async function containerLogs(machineId: string, ref: string, tail = 200): Promise<ActionReply<LogsResult>> {
  const session = await adminSession()
  if (!session) return { ok: false, message: "Only an admin can read logs." }
  const m = await machineFor(machineId)
  if (!m) return { ok: false, message: "This machine no longer exists." }
  const r = await getContainerLogs(m, ref, tail)
  return r.ok ? { ok: true, data: r.data } : { ok: false, message: r.message }
}

// ---- Console (Files, Search, Run) --------------------------------------------
// Admin only, like everything on a machine. Reads, lists and searches are
// not recorded; starting a command is (lib/machines.ts).

async function consoleMachine(machineId: string, what: string) {
  const session = await adminSession()
  if (!session) return { ok: false as const, message: `Only an admin can ${what}.` }
  const m = await machineFor(machineId)
  if (!m) return { ok: false as const, message: "This machine no longer exists." }
  return { ok: true as const, m, userId: session.user.id }
}

function reply<T>(r: { ok: true; data: T } | { ok: false; message: string }): ActionReply<T> {
  return r.ok ? { ok: true, data: r.data } : { ok: false, message: r.message }
}

export async function consoleList(machineId: string, root: string, path: string): Promise<ActionReply<DirList>> {
  const c = await consoleMachine(machineId, "browse files")
  if (!c.ok) return c
  return reply(await listMachineDir(c.m, root, path))
}

export async function consoleRead(machineId: string, root: string, path: string, offset = 0): Promise<ActionReply<FileRead>> {
  const c = await consoleMachine(machineId, "read files")
  if (!c.ok) return c
  return reply(await readMachineFile(c.m, root, path, offset, 2000))
}

export async function consoleSearch(
  machineId: string, root: string, pattern: string, opts: { include?: string; ignoreCase?: boolean },
): Promise<ActionReply<SearchResult>> {
  const c = await consoleMachine(machineId, "search files")
  if (!c.ok) return c
  if (!pattern) return { ok: false, message: "Enter something to search for." }
  return reply(await searchMachineFiles(c.m, root, pattern, {
    include: opts.include || undefined, ignoreCase: opts.ignoreCase === true,
  }))
}

export async function consoleGlob(machineId: string, root: string, pattern: string): Promise<ActionReply<GlobResult>> {
  const c = await consoleMachine(machineId, "search files")
  if (!c.ok) return c
  if (!pattern) return { ok: false, message: "Enter a file name pattern, for example *.ts." }
  return reply(await globMachineFiles(c.m, root, pattern))
}

export async function consoleRun(
  machineId: string, root: string, command: string, timeoutSeconds: number,
): Promise<ActionReply<CommandStatus & { jobId: string }>> {
  const c = await consoleMachine(machineId, "run commands")
  if (!c.ok) return c
  if (!command.trim()) return { ok: false, message: "Enter a command." }
  const r = reply(await startMachineCommand(c.m, c.userId, root, command, timeoutSeconds))
  revalidatePath(`/machines/${machineId}`)
  return r
}

export async function consoleStatus(machineId: string, jobId: string, tail = 0): Promise<ActionReply<CommandDetail>> {
  const c = await consoleMachine(machineId, "watch commands")
  if (!c.ok) return c
  return reply(await getMachineCommand(c.m, jobId, tail))
}

export async function consoleStop(machineId: string, jobId: string): Promise<ActionReply<CommandStatus>> {
  const c = await consoleMachine(machineId, "stop commands")
  if (!c.ok) return c
  const r = reply(await stopMachineCommand(c.m, jobId))
  revalidatePath(`/machines/${machineId}`)
  return r
}

export async function consoleJobs(machineId: string): Promise<ActionReply<{ jobs: CommandStatus[] }>> {
  const c = await consoleMachine(machineId, "watch commands")
  if (!c.ok) return c
  return reply(await listMachineCommands(c.m))
}

// ---- Machine settings -------------------------------------------------------

export type InstallView = { name: string; address: string; yaml: string; dir: string; image: string }

export async function reissueCertificate(machineId: string): Promise<ActionReply<InstallView>> {
  const session = await adminSession()
  if (!session) return { ok: false, message: "Only an admin can reissue certificates." }
  try {
    const r = await reissueMachineCert(machineId, session.user.id)
    if (!r.ok) return r
    revalidatePath(`/machines/${machineId}`)
    revalidatePath("/machines")
    return {
      ok: true,
      data: { name: r.machine.name, address: r.machine.address, yaml: installFile(r.machine, r.install), dir: AGENT_DIR, image: AGENT_IMAGE },
    }
  } catch (e) {
    return { ok: false, message: `No new certificate was issued: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export async function removeMachineAction(machineId: string, typed: string): Promise<ActionReply<null>> {
  const session = await adminSession()
  if (!session) return { ok: false, message: "Only an admin can remove machines." }
  if (typed.trim().toLowerCase() !== REMOVE_PHRASE) return { ok: false, message: `Type "${REMOVE_PHRASE}" to confirm.` }
  const r = await removeMachine(machineId, session.user.id)
  if (!r.ok) return r
  revalidatePath("/machines")
  redirect("/machines")
}
