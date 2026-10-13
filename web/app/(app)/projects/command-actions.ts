"use server"

import { revalidatePath } from "next/cache"
import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import { addCommand, moveCommand, removeCommand, updateCommand, type CommandInput } from "@/lib/project-commands"

// Project command buttons (admin only, like Projects). Every action checks
// the admin itself; none throws to the browser. Buttons run from the
// Dashboard toolbar (workspace/actions.ts).

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
