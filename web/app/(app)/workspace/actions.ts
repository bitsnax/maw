"use server"

import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import { liveStates, type LiveState } from "@/lib/session-status"
import { removeSession, startSession } from "@/lib/sessions"
import { listCommands } from "@/lib/project-commands"
import { listRuns, settleRun, startRun, type RunView } from "@/lib/command-runs"

// The Dashboard workspace (admin only, like Projects): the project and
// session pickers, the project's command buttons, and button runs shown in
// the output window. Every action checks the admin itself; none throws to
// the browser.

type Reply<T> = { ok: true; data: T } | { ok: false; message: string }

export type WsProject = { id: string; name: string; machineName: string; root: string; active: number }
export type WsSession = { id: string; title: string; updatedAt: string; user: string | null; live: LiveState | null }
export type WsCommand = { id: string; title: string; command: string }
export type WsElsewhere = { id: string; title: string; projectId: string; projectName: string; live: LiveState }
export type WsSnapshot = {
  projects: WsProject[]
  project: WsProject | null
  sessions: WsSession[]
  commands: WsCommand[]
  elsewhere: WsElsewhere[]
  unreachable: string | null
}

/** Everything the toolbar shows, for one project (the first when none is
 *  named). Asked again every few seconds for the live states. */
export async function workspaceSnapshot(projectId: string | null): Promise<Reply<WsSnapshot>> {
  if (!(await adminSession())) return { ok: false, message: "The workspace is for admins." }
  const [rows, { states, unreachable }] = await Promise.all([
    prisma.project.findMany({
      orderBy: { name: "asc" },
      include: {
        machine: { select: { name: true } },
        sessions: { orderBy: { updatedAt: "desc" }, include: { user: { select: { name: true, email: true } } } },
      },
    }),
    liveStates(),
  ])
  const projects: WsProject[] = rows.map((p) => ({
    id: p.id, name: p.name, machineName: p.machine.name, root: p.root,
    active: p.sessions.filter((s) => states.has(s.id)).length,
  }))
  const row = rows.find((p) => p.id === projectId) ?? rows[0] ?? null
  const elsewhere = rows.filter((p) => p.id !== row?.id).flatMap((p) =>
    p.sessions.filter((s) => states.has(s.id)).map((s) => ({ id: s.id, title: s.title, projectId: p.id, projectName: p.name, live: states.get(s.id)! })))
  return {
    ok: true,
    data: {
      projects,
      project: row ? projects.find((p) => p.id === row.id)! : null,
      sessions: (row?.sessions ?? []).map((s) => ({
        id: s.id, title: s.title, updatedAt: s.updatedAt.toISOString(), user: s.user?.name || s.user?.email || null, live: states.get(s.id) ?? null,
      })),
      commands: row ? (await listCommands(row.id)).map((c) => ({ id: c.id, title: c.title, command: c.command })) : [],
      elsewhere,
      unreachable,
    },
  }
}

/** A new session in the project; the title defaults to the project and time. */
export async function newWorkspaceSession(projectId: string, title: string): Promise<Reply<{ id: string; title: string }>> {
  const a = await adminSession()
  if (!a) return { ok: false, message: "Only an admin can start sessions." }
  const r = await startSession(projectId, a.user.id, title.trim().slice(0, 120))
  return r.ok ? { ok: true, data: { id: r.session.id, title: r.session.title } } : { ok: false, message: r.message }
}

export async function removeWorkspaceSession(sessionId: string): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can remove sessions." }
  const r = await removeSession(sessionId)
  return r.ok ? { ok: true, data: null } : { ok: false, message: r.message }
}

/** Button runs shown with this session (null: those made with none open);
 *  runs that ended while nobody watched are settled first. */
export async function workspaceRuns(projectId: string, sessionId: string | null): Promise<Reply<RunView[]>> {
  if (!(await adminSession())) return { ok: false, message: "The workspace is for admins." }
  const runs = await listRuns(projectId, sessionId)
  const settled = await Promise.all(runs.map((r) => (r.state === "running" ? settleRun(r.id) : r)))
  return { ok: true, data: settled.filter((r): r is RunView => !!r) }
}

export async function runWorkspaceCommand(commandId: string, values: Record<string, string>, sessionId: string | null): Promise<Reply<RunView>> {
  const a = await adminSession()
  if (!a) return { ok: false, message: "Only an admin can run commands." }
  const r = await startRun(commandId, values, sessionId, a.user.id)
  return r.ok ? { ok: true, data: r.run } : { ok: false, message: r.message }
}

/** Called when a run's live output ends: keeps the output with the run. */
export async function settleWorkspaceRun(runId: string): Promise<Reply<RunView>> {
  if (!(await adminSession())) return { ok: false, message: "The workspace is for admins." }
  const r = await settleRun(runId)
  return r ? { ok: true, data: r } : { ok: false, message: "This run no longer exists." }
}
