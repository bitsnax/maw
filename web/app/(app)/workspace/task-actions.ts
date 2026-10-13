"use server"

import { revalidatePath } from "next/cache"
import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import {
  PHASE_STATUS, STEP_STATUS, TASK_STATUS, createTask, getTask, removeTask, saveProfile, taskKey, updateTask,
  type NewTaskInput,
} from "@/lib/tasks"
import {
  JOB_LABEL, approvePhases, approveSteps, checkStep, markStepDone, pauseTask, planPhase, reopenStep, replanPhases, replanSteps, resumeTask, retryStep,
  runnerSeen, setTaskBranch, stopTaskJobs,
} from "@/lib/task-runner"
import { liveStates } from "@/lib/session-status"

// Tasks (admin only, like Projects). Every action checks the admin itself;
// none throws to the browser.

const BRANCH_NEEDED = "MAW changes files only on the task's own branch; give it one (you create it with your command button)."

type Reply<T> = { ok: true; data: T } | { ok: false; message: string; errors?: Record<string, string> }

type Finding = { id: string; heading: string; body: string }
type Item = { id: string; text: string; checked: boolean; developer: boolean; answer: string | null; findings: Finding[] }
export type TaskView = {
  id: string; projectId: string; number: number; key: string; title: string; request: string
  status: string; statusLabel: string; branch: string | null; updatedAt: string
  /** Where Resume / Retry returns the task: planning or in-progress. */
  resumeTo: string | null
  /** Why the runner waits before the next step (the branch), or "". */
  runnerNote: string
  overview: string; outOfScope: string; notes: string
  items: Item[]; findings: Finding[]
  /** The sessions MAW ran for the task, newest first. */
  jobs: Job[]
  /** The running session and what it is doing, if any. */
  now: { job: Job; activity: string } | null
  /** Seconds since the runner last went round its loop (null: never seen). */
  runnerAge: number | null
  phases: {
    id: string; number: number; title: string; goal: string; approach: string; notes: string; status: string; statusLabel: string
    items: Item[]; findings: Finding[]
    steps: {
      id: string; number: number; title: string; files: string; check: boolean; status: string; statusLabel: string
      goal: string; readBudget: string; context: string; changes: string; verification: string
      manualCheck: string; result: string; verifyOutput: string; diff: string; deploy: boolean; deployOutput: string
    }[]
  }[]
}

export type Job = {
  id: string; label: string; state: string; note: string; sessionId: string; session: boolean
  createdAt: string; endedAt: string | null
}

const f = (x: { id: string; heading: string; body: string }): Finding => ({ id: x.id, heading: x.heading, body: x.body })
const item = (q: { id: string; text: string; checked: boolean; developer: boolean; answer: string | null; findings: Finding[] }): Item =>
  ({ id: q.id, text: q.text, checked: q.checked, developer: q.developer, answer: q.answer, findings: q.findings.map(f) })

export async function taskView(id: string): Promise<Reply<TaskView>> {
  if (!(await adminSession())) return { ok: false, message: "Tasks are for admins." }
  const s = await getTask(id)
  if (!s) return { ok: false, message: "This task no longer exists." }
  const rows = await prisma.taskJob.findMany({
    where: { taskId: s.id }, orderBy: { createdAt: "desc" }, take: 200,
    include: { item: { select: { position: true } }, phase: { select: { number: true } }, step: { select: { number: true } } },
  })
  const sessions = new Set((await prisma.projectSession.findMany({ where: { id: { in: rows.map((j) => j.sessionId) } }, select: { id: true } })).map((x) => x.id))
  const jobs: Job[] = rows.map((j) => ({
    id: j.id, state: j.state, note: j.note, sessionId: j.sessionId, session: sessions.has(j.sessionId),
    label: `${JOB_LABEL[j.kind] ?? j.kind}${j.item ? ` ${j.phase ? `${j.phase.number}.` : ""}${j.item.position}` : j.step && j.phase ? ` ${j.phase.number}.${j.step.number}` : j.phase ? ` (phase ${j.phase.number})` : ""}`,
    createdAt: j.createdAt.toISOString(), endedAt: j.endedAt?.toISOString() ?? null,
  }))
  const running = jobs.find((j) => j.state === "running") ?? null
  let now: TaskView["now"] = null
  if (running) {
    const live = (await liveStates([s.projectId])).states.get(running.sessionId)
    now = { job: running, activity: live?.activity ?? "Starting" }
  }
  const seen = runnerSeen()
  return {
    ok: true,
    data: {
      id: s.id, projectId: s.projectId, number: s.number, key: taskKey(s), title: s.title, request: s.request,
      status: s.status, statusLabel: TASK_STATUS[s.status] ?? s.status, branch: s.branch, resumeTo: s.resumeTo, runnerNote: s.runnerNote, updatedAt: s.updatedAt.toISOString(),
      overview: s.overview, outOfScope: s.outOfScope, notes: s.notes,
      items: s.items.map(item), findings: s.findings.map(f),
      jobs, now, runnerAge: seen ? Math.max(0, Math.round((Date.now() - seen.getTime()) / 1000)) : null,
      phases: s.phases.map((p) => ({
        id: p.id, number: p.number, title: p.title, goal: p.goal, approach: p.approach, notes: p.notes,
        status: p.status, statusLabel: PHASE_STATUS[p.status] ?? p.status,
        items: p.items.map(item), findings: p.findings.map(f),
        steps: p.steps.map((x) => ({
          id: x.id, number: x.number, title: x.title, files: x.files, check: x.check, status: x.status, statusLabel: STEP_STATUS[x.status] ?? x.status,
          goal: x.goal, readBudget: x.readBudget, context: x.context, changes: x.changes, verification: x.verification,
          manualCheck: x.manualCheck, result: x.result, verifyOutput: x.verifyOutput, diff: x.diff, deploy: x.deploy, deployOutput: x.deployOutput,
        })),
      })),
    },
  }
}

export async function newTask(projectId: string, input: NewTaskInput): Promise<Reply<{ id: string }>> {
  const a = await adminSession()
  if (!a) return { ok: false, message: "Only an admin can write tasks." }
  if (!(await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }))) return { ok: false, message: "This project no longer exists." }
  if (!input.branch?.trim()) return { ok: false, message: "Check the fields below.", errors: { branch: BRANCH_NEEDED } }
  const r = await createTask(projectId, a.user.id, input)
  if (!r.ok) return { ok: false, message: "Check the fields below.", errors: r.errors }
  revalidatePath(`/projects/${projectId}`)
  return { ok: true, data: { id: r.task.id } }
}

export async function editTask(id: string, input: NewTaskInput): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can change tasks." }
  const s = await prisma.task.findUnique({ where: { id }, select: { projectId: true } })
  if (!input.branch?.trim()) return { ok: false, message: "Check the fields below.", errors: { branch: BRANCH_NEEDED } }
  const r = await updateTask(id, input)
  if (!r.ok) return { ok: false, message: r.message ?? "Check the fields below.", errors: r.errors }
  if (s) revalidatePath(`/projects/${s.projectId}`)
  return { ok: true, data: null }
}

export async function deleteTask(id: string): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can remove tasks." }
  const s = await prisma.task.findUnique({ where: { id }, select: { projectId: true } })
  await stopTaskJobs(id, "The task was removed.")
  await removeTask(id)
  if (s) revalidatePath(`/projects/${s.projectId}`)
  return { ok: true, data: null }
}

/** Your answer to a checklist item marked for you; answering checks it. */
export async function answerTaskItem(itemId: string, answer: string): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can answer." }
  const a = answer.trim()
  if (!a) return { ok: false, message: "Write the answer first." }
  const q = await prisma.taskItem.update({ where: { id: itemId }, data: { answer: a, checked: true, checkedAt: new Date() } }).catch(() => null)
  return q ? { ok: true, data: null } : { ok: false, message: "This item no longer exists." }
}

/** The task's planning, from the Dashboard: pause, resume or retry, approve
 *  the phases, or plan them again (with your direction, optional). */
export async function taskControl(id: string, act: "pause" | "resume" | "approve-phases" | "replan-phases", direction = ""): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can do that." }
  const r = act === "pause" ? await pauseTask(id) : act === "resume" ? await resumeTask(id)
    : act === "approve-phases" ? await approvePhases(id) : act === "replan-phases" ? await replanPhases(id, direction)
    : { ok: false as const, message: "Unknown action." }
  return r.ok ? { ok: true, data: null } : r
}

/** A phase's planning, from the Dashboard: plan its steps (with your direction,
 *  optional), approve them, or plan them again. */
export async function phaseControl(phaseId: string, act: "plan-steps" | "approve-steps" | "replan-steps", direction = ""): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can do that." }
  const r = act === "plan-steps" ? await planPhase(phaseId, direction) : act === "approve-steps" ? await approveSteps(phaseId)
    : act === "replan-steps" ? await replanSteps(phaseId, direction) : { ok: false as const, message: "Unknown action." }
  return r.ok ? { ok: true, data: null } : r
}

/** A step, from the Dashboard: your manual check (right / not right with a
 *  note), run a blocked step again (with a direction), or mark it done. */
export async function stepControl(stepId: string, act: "checked" | "not-right" | "retry" | "mark-done" | "reopen", text = ""): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can do that." }
  const r = act === "checked" ? await checkStep(stepId, true, text) : act === "not-right" ? await checkStep(stepId, false, text)
    : act === "retry" ? await retryStep(stepId, text) : act === "mark-done" ? await markStepDone(stepId) : act === "reopen" ? await reopenStep(stepId, text)
    : { ok: false as const, message: "Unknown action." }
  return r.ok ? { ok: true, data: null } : r
}

/** The task's branch, from the Dashboard's bar. */
export async function saveTaskBranch(taskId: string, branch: string): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can change tasks." }
  const r = await setTaskBranch(taskId, branch)
  return r.ok ? { ok: true, data: null } : r
}

export async function saveProjectProfile(projectId: string, input: { profile: string; verifyCommands: string; protectedBranches: string; deployCommand: string }): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can change the profile." }
  await saveProfile(projectId, {
    profile: input.profile,
    verifyCommands: input.verifyCommands.split("\n"),
    protectedBranches: input.protectedBranches.split(/[,\s]+/),
    deployCommand: input.deployCommand,
  })
  revalidatePath(`/projects/${projectId}`)
  return { ok: true, data: null }
}
