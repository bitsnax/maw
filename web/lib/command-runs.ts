import { prisma } from "./prisma"
import { getMachineCommand, startMachineCommand, type CommandState } from "./machines"
import { fillCommand } from "./project-commands"

// Command button runs: started in the project folder on its machine (never
// through OpenCode), recorded under the machine's Recent actions, and kept
// here so the Dashboard's output window can show them among the session's
// messages, output included, after a reload.

export const KEEP_LINES = 500
export type RunLine = { s: "o" | "e"; t: string }
export type RunView = {
  id: string; title: string; command: string; machineId: string; jobId: string; sessionId: string | null; storyId: string | null
  state: CommandState; exitCode: number | null; durationMs: number | null
  lines: RunLine[] | null; startedAt: string; endedAt: string | null; user: string | null
}

type Row = Awaited<ReturnType<typeof prisma.commandRun.findFirstOrThrow>> & { user?: { name: string | null; email: string } | null }
export function view(r: Row): RunView {
  return {
    id: r.id, title: r.title, command: r.command, machineId: r.machineId, jobId: r.jobId, sessionId: r.sessionId, storyId: r.storyId,
    state: r.state as CommandState, exitCode: r.exitCode, durationMs: r.durationMs,
    lines: (r.lines as RunLine[] | null) ?? null, startedAt: r.startedAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? null,
    user: r.user ? r.user.name || r.user.email : null,
  }
}

/** Runs a button: placeholders filled, 10-minute limit, recorded with you as Who. */
export async function startRun(commandId: string, values: Record<string, string>, sessionId: string | null, userId: string | null, storyId: string | null = null) {
  const c = await prisma.projectCommand.findUnique({ where: { id: commandId }, include: { project: { include: { machine: true } } } })
  if (!c) return { ok: false as const, message: "This button no longer exists." }
  const f = fillCommand(c.command, values)
  if (!f.ok) return { ok: false as const, message: `Fill in ${f.missing.map((n) => `{${n}}`).join(", ")}.` }
  const r = await startMachineCommand(c.project.machine, userId, c.project.root, f.command, 600)
  if (!r.ok) return { ok: false as const, message: r.message }
  const row = await prisma.commandRun.create({
    data: {
      projectId: c.projectId, sessionId, storyId, userId, title: c.title, command: f.command,
      machineId: c.project.machine.id, jobId: r.data.jobId, startedAt: new Date(r.data.startedAt),
    },
    include: { user: { select: { name: true, email: true } } },
  })
  return { ok: true as const, run: view(row) }
}

/** Asks the agent how the run ended and keeps its output; a run still going
 *  is returned unchanged. An agent that no longer knows the job (restarted,
 *  or more than an hour later) ends the run as "failed". */
export async function settleRun(runId: string): Promise<RunView | null> {
  const r = await prisma.commandRun.findUnique({ where: { id: runId }, include: { user: { select: { name: true, email: true } } } })
  if (!r) return null
  if (r.state !== "running") return view(r)
  const m = await prisma.machine.findUnique({ where: { id: r.machineId } })
  const d = m ? await getMachineCommand(m, r.jobId, KEEP_LINES) : null
  if (d?.ok && d.data.state === "running") return view(r)
  const lines: RunLine[] = d?.ok ? d.data.lines.filter((l) => !l.login).map((l) => ({ s: l.stream === "stderr" ? "e" : "o", t: l.text })) : []
  const done = await prisma.commandRun.update({
    where: { id: r.id },
    data: d?.ok
      ? { state: d.data.state, exitCode: d.data.exitCode, durationMs: d.data.durationMs, lines, endedAt: d.data.endedAt ? new Date(d.data.endedAt) : new Date() }
      : { state: "failed", lines: [{ s: "e", t: d ? d.message : "The machine no longer exists." }], endedAt: new Date() },
    include: { user: { select: { name: true, email: true } } },
  })
  return view(done)
}

/** The runs shown with a session or a story (with both null: those made
 *  with neither open). */
export async function listRuns(projectId: string, sessionId: string | null, take = 40, storyId: string | null = null) {
  const rows = await prisma.commandRun.findMany({
    where: { projectId, sessionId, storyId }, orderBy: { startedAt: "desc" }, take,
    include: { user: { select: { name: true, email: true } } },
  })
  return rows.reverse().map(view)
}
