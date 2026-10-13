import { prisma } from "./prisma"
import type { TaskAlert } from "./alert-tones"

export type { TaskAlert }

// What the Dashboard listens to for its sounds: one short line per task
// (across every project) that changes when the task reaches a point that
// matters to you. The browser compares each snapshot with the last one and
// plays a tone (app/(app)/workspace/sounds.ts):
//   finished   the task is done
//   error      the task is blocked
//   question   a step waits for your check, or an item waits for your answer
//   stopped    the task stops for you without an error: phases or steps to
//              approve, a phase to plan, a branch to make or switch to
// Sessions are watched from their live states (not here).


export async function taskAlerts(): Promise<TaskAlert[]> {
  const [tasks, checks, items, phases] = await Promise.all([
    prisma.task.findMany({ select: { id: true, number: true, title: true, status: true, runnerNote: true, project: { select: { name: true } } } }),
    prisma.taskStep.findMany({ where: { status: "waiting-check" }, select: { phase: { select: { taskId: true } } } }),
    prisma.taskItem.groupBy({ by: ["taskId"], where: { developer: true, checked: false }, _count: { _all: true } }),
    prisma.taskPhase.findMany({ where: { status: { not: "done" } }, orderBy: { number: "asc" }, select: { taskId: true, status: true } }),
  ])
  const count = (xs: string[]) => xs.reduce((m, id) => m.set(id, (m.get(id) ?? 0) + 1), new Map<string, number>())
  const c = count(checks.map((x) => x.phase.taskId))
  const i = new Map(items.map((x) => [x.taskId, x._count._all]))
  const first = new Map<string, string>()
  for (const p of phases) if (!first.has(p.taskId)) first.set(p.taskId, p.status)
  return tasks.map((s) => ({
    id: s.id, project: s.project.name, number: s.number, title: s.title, status: s.status,
    checks: c.get(s.id) ?? 0, items: i.get(s.id) ?? 0,
    approvals: s.status === "in-progress" && (first.get(s.id) === "steps-ready" || first.get(s.id) === "pending") ? 1 : 0,
    note: s.runnerNote,
  }))
}

