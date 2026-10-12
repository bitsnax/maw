"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import { getMachineInfo, listMachineDir } from "@/lib/machines"
import { createProject, removeProject } from "@/lib/projects"
import { REMOVE_PROJECT_PHRASE } from "./phrases"

export type AddProjectState =
  | { status: "idle" }
  | { status: "error"; message?: string; errors: Record<string, string>; values: Record<string, string> }

// On success this redirects to the new project's page.
export async function addProject(_prev: AddProjectState, form: FormData): Promise<AddProjectState> {
  const values = {
    name: String(form.get("name") ?? "").trim(),
    machineId: String(form.get("machineId") ?? ""),
    root: String(form.get("root") ?? "").trim(),
  }
  const session = await adminSession()
  if (!session) return { status: "error", message: "Only an admin can add projects.", errors: {}, values }
  let id: string
  try {
    const r = await createProject(values, session.user.id)
    if (!r.ok) return { status: "error", message: r.message, errors: r.errors, values }
    id = r.project.id
  } catch (e) {
    return { status: "error", message: `The project was not added: ${e instanceof Error ? e.message : String(e)}`, errors: {}, values }
  }
  revalidatePath("/projects")
  redirect(`/projects/${id}`)
}

export type FolderChoices = { ok: true; base: string; folders: string[] } | { ok: false; message: string }

/** The folders under a machine's base (/opt), to pick a project root from. */
export async function machineFolders(machineId: string): Promise<FolderChoices> {
  const session = await adminSession()
  if (!session) return { ok: false, message: "Only an admin can add projects." }
  const m = await prisma.machine.findUnique({ where: { id: machineId } })
  if (!m) return { ok: false, message: "That machine no longer exists." }
  const info = await getMachineInfo(m)
  if (!info.ok) return { ok: false, message: info.message }
  const base = info.data.agent.allowedBase ?? "/opt"
  const l = await listMachineDir(m, base, ".")
  if (!l.ok) return { ok: false, message: l.message }
  const taken = new Set((await prisma.project.findMany({ where: { machineId }, select: { root: true } })).map((p) => p.root))
  return {
    ok: true,
    base,
    folders: l.data.entries
      .filter((e) => e.type === "dir" || e.target === "dir")
      .map((e) => `${base}/${e.name}`)
      .filter((f) => !taken.has(f)),
  }
}

export async function removeProjectAction(projectId: string, typed: string): Promise<{ ok: false; message: string }> {
  const session = await adminSession()
  if (!session) return { ok: false, message: "Only an admin can remove projects." }
  if (typed.trim().toLowerCase() !== REMOVE_PROJECT_PHRASE) return { ok: false, message: `Type "${REMOVE_PROJECT_PHRASE}" to confirm.` }
  const r = await removeProject(projectId, session.user.id)
  if (!r.ok) return r
  revalidatePath("/projects")
  redirect("/projects")
}
