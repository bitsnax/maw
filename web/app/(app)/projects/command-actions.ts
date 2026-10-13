"use server"

import { revalidatePath } from "next/cache"
import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import { startMachineCommand, type CommandStatus } from "@/lib/machines"
import { addCommand, fillCommand, moveCommand, removeCommand, updateCommand, type CommandInput } from "@/lib/project-commands"

// Project command buttons (admin only, like Projects). Every action checks
// the admin itself; none throws to the browser. Watching and stopping a
// running button uses the Console's actions (machines/actions.ts).

type Reply<T> = { ok: true; data: T } | { ok: false; message: string; errors?: Record<string, string> }

async function admin() {
  return (await adminSession()) ?? null
}
async function projectOf(commandId: string) {
  return prisma.projectCommand.findUnique({ where: { id: commandId }, select: { projectId: true } })
}

export async function addProjectCommand(projectId: string, input: CommandInput): Promise<Reply<null>> {
  const a = await admin()
  if (!a) return { ok: false, message: "Only an admin can add commands." }
  if (!(await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }))) return { ok: false, message: "This project no longer exists." }
  const r = await addCommand(projectId, a.user.id, input)
  if (!r.ok) return { ok: false, message: "Check the fields below.", errors: r.errors }
  revalidatePath(`/projects/${projectId}`, "layout")
  return { ok: true, data: null }
}

export async function updateProjectCommand(id: string, input: CommandInput): Promise<Reply<null>> {
  if (!(await admin())) return { ok: false, message: "Only an admin can change commands." }
  const p = await projectOf(id)
  const r = await updateCommand(id, input)
  if (!r.ok) return { ok: false, message: r.message ?? "Check the fields below.", errors: r.errors }
  if (p) revalidatePath(`/projects/${p.projectId}`, "layout")
  return { ok: true, data: null }
}

export async function removeProjectCommand(id: string): Promise<Reply<null>> {
  if (!(await admin())) return { ok: false, message: "Only an admin can remove commands." }
  const p = await projectOf(id)
  await removeCommand(id)
  if (p) revalidatePath(`/projects/${p.projectId}`, "layout")
  return { ok: true, data: null }
}

export async function moveProjectCommand(id: string, by: -1 | 1): Promise<Reply<null>> {
  if (!(await admin())) return { ok: false, message: "Only an admin can reorder commands." }
  const p = await projectOf(id)
  await moveCommand(id, by === -1 ? -1 : 1)
  if (p) revalidatePath(`/projects/${p.projectId}`, "layout")
  return { ok: true, data: null }
}

export type StartedCommand = CommandStatus & { jobId: string; machineId: string; title: string }

/** Runs a button: placeholders filled (each value one shell word), in the
 *  project folder on its machine, as the machine's user; recorded under the
 *  machine's Recent actions with you as Who. Time limit 10 minutes. */
export async function runProjectCommand(id: string, values: Record<string, string>): Promise<Reply<StartedCommand>> {
  const a = await admin()
  if (!a) return { ok: false, message: "Only an admin can run commands." }
  const c = await prisma.projectCommand.findUnique({ where: { id }, include: { project: { include: { machine: true } } } })
  if (!c) return { ok: false, message: "This button no longer exists." }
  const f = fillCommand(c.command, values)
  if (!f.ok) return { ok: false, message: `Fill in ${f.missing.map((n) => `{${n}}`).join(", ")}.` }
  const r = await startMachineCommand(c.project.machine, a.user.id, c.project.root, f.command, 600)
  if (!r.ok) return { ok: false, message: r.message }
  revalidatePath(`/machines/${c.project.machine.id}`)
  return { ok: true, data: { ...r.data, machineId: c.project.machine.id, title: c.title } }
}
