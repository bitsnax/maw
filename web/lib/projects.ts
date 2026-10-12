import path from "node:path"
import { prisma } from "./prisma"
import { getMachineInfo, listMachineDir, recordAction } from "./machines"
import { ocDeleteSession } from "./opencode"

// Projects: a folder on a paired machine that OpenCode sessions work in.
//
// Not a "use server" file, so self-tests can call it directly. Pages and
// server actions that call it check the session and role "admin" first
// (Projects are admin-only in Phase 3, like Machines).

export type NewProjectInput = { name: string; machineId: string; root: string }

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/

/** A root as typed: trimmed, absolute, normalized, no trailing slash. */
export function normalizeRoot(root: string): string {
  const r = root.trim()
  if (!r.startsWith("/")) return r
  const n = path.posix.normalize(r)
  return n.length > 1 ? n.replace(/\/+$/, "") : n
}

/** Checks the fields that need no machine; readable messages per field. */
export function checkProjectInput(i: NewProjectInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!NAME.test(i.name.trim())) errors.name = "Use letters, digits, spaces, dots, dashes or underscores (for example caw)."
  if (!i.machineId) errors.machineId = "Pick a machine."
  const root = normalizeRoot(i.root)
  if (!root.startsWith("/")) errors.root = "Enter the folder's full path, for example /opt/caw."
  else if (root === "/" || root.split("/").filter(Boolean).length < 2) errors.root = "Pick a folder inside /opt, not /opt itself."
  return errors
}

/** The workspace folder name in maw-opencode: <machine>-<folder>, lowercase, unique. */
export async function makeSlug(machineName: string, root: string): Promise<string> {
  const base = `${machineName}-${path.posix.basename(root)}`
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "project"
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`
    if (!(await prisma.project.findUnique({ where: { slug }, select: { id: true } }))) return slug
  }
}

export async function createProject(
  input: NewProjectInput,
  userId: string | null,
): Promise<{ ok: true; project: { id: string; name: string; slug: string } } | { ok: false; errors: Record<string, string>; message?: string }> {
  const i = { name: input.name.trim(), machineId: input.machineId, root: normalizeRoot(input.root) }
  const errors = checkProjectInput(i)
  if (Object.keys(errors).length) return { ok: false, errors }

  const m = await prisma.machine.findUnique({ where: { id: i.machineId } })
  if (!m) return { ok: false, errors: { machineId: "That machine no longer exists." } }
  if (await prisma.project.findUnique({ where: { name: i.name }, select: { id: true } })) {
    return { ok: false, errors: { name: `A project named ${i.name} already exists.` } }
  }
  const same = await prisma.project.findUnique({ where: { machineId_root: { machineId: m.id, root: i.root } }, select: { name: true } })
  if (same) return { ok: false, errors: { root: `Project ${same.name} already uses ${i.root} on ${m.name}.` } }

  // The folder must be inside the agent's base (/opt, the only host folder
  // it mounts), said plainly before asking the agent: the agent checks that
  // the folder exists first, and a folder outside /opt never exists for it.
  const info = await getMachineInfo(m)
  if (!info.ok) return { ok: false, errors: {}, message: `${m.name} could not check the folder: ${info.message}` }
  const base = info.data.agent.allowedBase ?? "/opt"
  if (i.root === base || !i.root.startsWith(base + "/")) {
    return { ok: false, errors: { root: `${i.root} is outside ${base}, the only folder MAW can use on ${m.name}.` } }
  }

  // The folder must exist on the machine. The agent's answer says why not, if not.
  const check = await listMachineDir(m, i.root, ".")
  if (!check.ok) {
    return check.status === 400 || check.status === 404
      ? { ok: false, errors: { root: check.message } }
      : { ok: false, errors: {}, message: `${m.name} could not check the folder: ${check.message}` }
  }

  const slug = await makeSlug(m.name, i.root)
  try {
    const project = await prisma.project.create({
      data: { name: i.name, slug, machineId: m.id, root: i.root, createdById: userId },
      select: { id: true, name: true, slug: true },
    })
    await recordAction(m, userId, "project.add", i.root, true, `project ${i.name}`)
    return { ok: true, project }
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return { ok: false, errors: { name: "That name or folder is already a project." } }
    throw e
  }
}

/** Removes a project and MAW's records of its sessions. Nothing on the
 *  machine is touched. */
export async function removeProject(projectId: string, userId: string | null): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, include: { machine: true, sessions: { select: { id: true } } } })
  if (!p) return { ok: false, message: "This project no longer exists." }
  // Its conversations in OpenCode go too (best effort: OpenCode may be down).
  for (const s of p.sessions) await ocDeleteSession(`/workspaces/${p.slug}`, s.id).catch(() => null)
  await prisma.project.delete({ where: { id: p.id } })
  await recordAction(p.machine, userId, "project.remove", p.root, true, `project ${p.name}; its files on ${p.machine.name} are untouched`)
  return { ok: true, name: p.name }
}

export function listProjects() {
  return prisma.project.findMany({
    orderBy: { name: "asc" },
    include: {
      machine: { select: { id: true, name: true, address: true, port: true, certFingerprint: true, agentVersion: true } },
      _count: { select: { sessions: true } },
    },
  })
}
