"use server"

import { revalidatePath } from "next/cache"
import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import {
  createMachine, runContainerAction, getContainerLogs,
  type ContainerActionName, type ContainerActionResult, type LogsResult,
} from "@/lib/machines"
import { installFile, AGENT_DIR, AGENT_IMAGE } from "@/lib/install-file"

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
