import { prisma } from "./prisma"
import type { FullTask } from "./tasks"

// Time and tokens of a task's sessions, for the Dashboard: per step, per
// phase (its planning and its steps) and for the whole task, and a rough
// time left in the current phase.

/** Time in sessions (a running one up to now; for a step, its verify and deploy too) and tokens generated. */
export type Use = { ms: number; tokens: number; sessions: number }

export async function taskUsage(s: FullTask, now = Date.now()) {
  const all = await prisma.taskJob.findMany({ where: { taskId: s.id }, select: { phaseId: true, stepId: true, createdAt: true, endedAt: true, outputTokens: true } })
  const sum = (xs: typeof all): Use => xs.reduce((u, j) => ({
    ms: u.ms + Math.max(0, (j.endedAt?.getTime() ?? now) - j.createdAt.getTime()), tokens: u.tokens + j.outputTokens, sessions: u.sessions + 1,
  }), { ms: 0, tokens: 0, sessions: 0 })
  const step = (id: string) => sum(all.filter((j) => j.stepId === id))
  const phase = (id: string) => sum(all.filter((j) => j.phaseId === id))
  // The average done step (the task's own pace), times the current phase's steps still to run, less what each has used.
  const done = s.phases.flatMap((p) => p.steps).filter((x) => x.status === "done").map((x) => step(x.id)).filter((u) => u.sessions > 0)
  const avg = done.length ? done.reduce((n, u) => n + u.ms, 0) / done.length : null
  const cur = s.phases.find((p) => p.status !== "done")
  const toRun = cur?.status === "in-progress" ? cur.steps.filter((x) => !["done", "check-later", "waiting-check"].includes(x.status)) : []
  const leftMs = avg !== null && toRun.length ? toRun.reduce((n, x) => n + Math.max(0, avg - step(x.id).ms), 0) : null
  return { task: sum(all), step, phase, leftMs }
}
