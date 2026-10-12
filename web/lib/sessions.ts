import { prisma } from "./prisma"
import { ensureWorkspace } from "./workspace"
import { ocCreateSession, ocDeleteSession } from "./opencode"

// Sessions: one OpenCode session in a project's workspace. OpenCode keeps the
// conversation; MAW keeps who started it, when, and in which project.

export async function startSession(projectId: string, userId: string | null, title: string) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, include: { machine: true } })
  if (!p) return { ok: false as const, message: "This project no longer exists." }
  let ws
  try {
    ws = await ensureWorkspace(p)
  } catch (e) {
    return { ok: false as const, message: `The workspace could not be prepared: ${e instanceof Error ? e.message : String(e)}` }
  }
  const t = title.trim() || `${p.name} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`
  const s = await ocCreateSession(ws.directory, t)
  if (!s.ok) return { ok: false as const, message: s.message }
  await prisma.projectSession.create({ data: { id: s.data.id, projectId: p.id, userId, title: t } })
  return { ok: true as const, session: { id: s.data.id, title: t, directory: ws.directory, agentsMd: ws.agentsMd } }
}

/** Removes the session from MAW and from OpenCode (its conversation is deleted). */
export async function removeSession(sessionId: string) {
  const s = await prisma.projectSession.findUnique({ where: { id: sessionId }, include: { project: true } })
  if (!s) return { ok: false as const, message: "This session no longer exists." }
  await ocDeleteSession(`/workspaces/${s.project.slug}`, s.id)
  await prisma.projectSession.delete({ where: { id: s.id } })
  return { ok: true as const }
}
