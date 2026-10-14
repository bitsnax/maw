import { mkdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { prisma } from "./prisma"
import { checkTaskInput, getTask, REPAIRS, type FullTask } from "./tasks"
import { startSession } from "./sessions"
import { workspacePath } from "./workspace"
import { WORKSPACES } from "./tools"
import { ocAbort, ocMessages, ocPrompt, ocQuestionReject, ocQuestions, ocStatus } from "./opencode"
import { checklistPrompt, itemPrompt, phaseChecklistPrompt, phaseItemPrompt, phaseStepsPrompt, phasesPrompt, stepPrompt } from "./task-prompts"
import { stepMd, type JobKind } from "./task-tools"
import { branchProblem, projectChanges, runDeploy, runVerify } from "./task-steps"

// The runner: MAW's own loop (scripts/runner.ts, the maw-runner service) that
// carries tasks forward one model session at a time. All its state is in
// the database (task status, task_job rows), so it can stop and start at
// any moment: a running job is picked up again and watched to its end.
// One job at a time across MAW (llama.cpp has one slot).
//
// Task planning (a task in status "planning"):
//   1. task-checklist  the questions the plan needs     → task checklist items
//   2. task-item       one session per open item         → findings, item checked
//      (an item still open after ITEM_SESSIONS sessions is handed to the developer)
//   3. wait while items marked for the developer are open (answered on the Dashboard)
//   4. task-phases     the overview and the phases       → status "phases-ready"
// Phase planning (a task "in-progress", its first phase that is not done):
//   pending        waits for you: "Plan steps" (with a direction, optional)
//   planning       phase-checklist (may add nothing) → phase-item per open item
//                  → wait for your items → phase-steps → phase "steps-ready"
//   steps-ready    waits for you: Approve steps (→ phase "in-progress") or Plan again
//   in-progress    its steps are carried out, one session each, in order:
//                    pending → (branch check) step session → step_finish
//                    → MAW runs the verify commands and records git status/diff
//                    → done, or "waiting-check" (a step marked Check: you check it),
//                    or a repair: the verify or deploy failed, so the step
//                    runs again with the failing output (REPAIRS times at
//                    most), then blocked; blocked too when the step said so,
//                    or STEP_SESSIONS sessions ended without step_finish
//                  when every step is done the phase is done; the next phase
//                  waits for Plan steps; the last phase done → task done.
// Hands-off approvals (task.approve): "steps" lets MAW start each phase's
// planning and approve its steps; "all" also approves the phases. With
// task.checksAtEnd a step marked Check is held ("check-later") and MAW goes
// on; when the phase's other steps are done, the held checks wait for you
// ("waiting-check"), one after another. Items for you always wait.
// A session that fails (model error, no answer, nothing recorded) sets the
// task to "blocked" with the reason on its job; Retry on the Dashboard
// returns it to where it was (task.resumeTo), as Resume does after Pause.

export const ITEM_SESSIONS = 3
/** Sessions on one step that may end without step_finish before it is blocked. */
export const STEP_SESSIONS = 3
const NOFINISH = "ended without step_finish; the next session continues from its notes"
/** A session longer than this is stopped and counts as failed. */
export const JOB_LIMIT_MS = 60 * 60_000
/** Time a session gets to start answering before it counts as failed. */
export const START_GRACE_MS = 120_000

export const JOB_LABEL: Record<string, string> = {
  "task-checklist": "Task checklist", "task-item": "Checklist item", "task-phases": "Task plan and phases",
  "phase-checklist": "Phase checklist", "phase-item": "Phase checklist item", "phase-steps": "Phase steps", step: "Step",
}

type Log = (line: string) => void
type Job = NonNullable<Awaited<ReturnType<typeof runningJob>>>
type Action =
  | { kind: "start"; job: JobKind; itemId?: string; position?: number; phaseId?: string; phaseNumber?: number; stepId?: string; stepNumber?: number }
  | { kind: "verify"; stepId: string }
  | { kind: "wait"; why: string }

const runningJob = (projectId?: string) => prisma.taskJob.findFirst({
  where: { state: "running", ...(projectId ? { task: { projectId } } : {}) }, orderBy: { createdAt: "asc" },
  include: { task: { include: { project: true } }, item: { select: { position: true } }, phase: { select: { number: true, status: true } }, step: { select: { number: true } } },
})

// ---- heartbeat: maw-web shows whether the runner is alive -------------------------

const LOCAL_DIR = process.env.MAW_WORKSPACES_DIR || WORKSPACES
const BEAT = () => path.join(LOCAL_DIR, ".maw-runner")

export function heartbeat() {
  try { mkdirSync(LOCAL_DIR, { recursive: true }); writeFileSync(BEAT(), new Date().toISOString()) } catch { /* shown as not running */ }
}
/** When the runner last went round its loop, or null. */
export function runnerSeen(): Date | null {
  try { return statSync(BEAT()).mtime } catch { return null }
}

// ---- what a task needs next ------------------------------------------------------

/** The next thing task planning needs. May hand an item to the developer. */
export async function planningAction(s: FullTask): Promise<Action> {
  const jobs = await prisma.taskJob.findMany({ where: { taskId: s.id, phaseId: null }, select: { kind: true, state: true, itemId: true } })
  if (!jobs.some((j) => j.kind === "task-checklist" && j.state === "done")) return { kind: "start", job: "task-checklist" }
  const next = await nextItem(s.id, s.items, jobs)
  if (next) return { kind: "start", job: "task-item", itemId: next.id, position: next.position }
  const open = await prisma.taskItem.count({ where: { taskId: s.id, phaseId: null, checked: false } })
  if (open) return { kind: "wait", why: `${open} checklist item${open === 1 ? "" : "s"} for you` }
  return { kind: "start", job: "task-phases" }
}

/** The first open item the agent should take (handing to the developer any it left open ITEM_SESSIONS times). */
async function nextItem(taskId: string, items: { id: string; position: number; checked: boolean; developer: boolean }[], jobs: { state: string; itemId: string | null }[]) {
  for (const q of items) {
    if (q.checked || q.developer) continue
    const tried = jobs.filter((j) => j.itemId === q.id && j.state === "done").length
    if (tried < ITEM_SESSIONS) return q
    // Still open after ITEM_SESSIONS sessions: the developer answers it.
    await prisma.taskItem.update({ where: { id: q.id }, data: { developer: true } })
    const it = await prisma.taskItem.findUniqueOrThrow({ where: { id: q.id }, select: { phaseId: true } })
    await prisma.taskFinding.create({
      data: {
        taskId, phaseId: it.phaseId, itemId: q.id, position: await nextFinding(taskId), heading: "Handed to you",
        body: `The agent left this item open after ${ITEM_SESSIONS} sessions. Answer it from what is known (see the findings), and planning goes on.`,
      },
    })
  }
  return null
}

/** The phase the task is at: its first phase that is not done. */
export function currentPhase<P extends { status: string }>(s: { phases: P[] }): P | null {
  return s.phases.find((p) => p.status !== "done") ?? null
}

/** The next thing phase planning needs (a task in progress). */
export async function phaseAction(s: FullTask): Promise<Action> {
  const ph = currentPhase(s)
  if (!ph) return { kind: "wait", why: "every phase is done" }
  // Hands-off: MAW plans the phase into steps, and approves them, as you would.
  if (s.approve !== "you" && ph.status === "pending") {
    const r = await prisma.taskPhase.updateMany({ where: { id: ph.id, status: "pending" }, data: { status: "planning" } })
    if (r.count) ph.status = "planning"
  }
  if (s.approve !== "you" && ph.status === "steps-ready") {
    const r = await prisma.taskPhase.updateMany({ where: { id: ph.id, status: "steps-ready" }, data: { status: "in-progress" } })
    if (r.count) ph.status = "in-progress"
  }
  if (ph.status === "in-progress") return stepAction(s, ph)
  if (ph.status !== "planning") return { kind: "wait", why: `phase ${ph.number} is ${ph.status}` }
  const jobs = await prisma.taskJob.findMany({ where: { phaseId: ph.id }, select: { kind: true, state: true, itemId: true } })
  const at = { phaseId: ph.id, phaseNumber: ph.number }
  if (!jobs.some((j) => j.kind === "phase-checklist" && j.state === "done")) return { kind: "start", job: "phase-checklist", ...at }
  const next = await nextItem(s.id, ph.items, jobs)
  if (next) return { kind: "start", job: "phase-item", itemId: next.id, position: next.position, ...at }
  const open = await prisma.taskItem.count({ where: { phaseId: ph.id, checked: false } })
  if (open) return { kind: "wait", why: `${open} phase checklist item${open === 1 ? "" : "s"} for you` }
  return { kind: "start", job: "phase-steps", ...at }
}

// ---- steps --------------------------------------------------------------------------

const branchChecks = new Map<string, { at: number; problem: string | null }>()
const BRANCH_CHECK_MS = 20_000
/** Self-tests: check the branch again at once. */
export function forgetBranchChecks() { branchChecks.clear() }

async function noteRunner(s: FullTask, note: string) {
  if (s.runnerNote !== note) await prisma.task.update({ where: { id: s.id }, data: { runnerNote: note } })
}

/** The next thing a phase in progress needs: its first step that is not done. */
async function stepAction(s: FullTask, ph: FullTask["phases"][number]): Promise<Action> {
  // Held checks wait for you once no other step of the phase is left to run
  // (or at once, when the setting was turned off).
  const held = ph.steps.filter((x) => x.status === "check-later").map((x) => x.id)
  const left = ph.steps.some((x) => !["done", "check-later", "waiting-check"].includes(x.status))
  if (held.length && (!s.checksAtEnd || !left)) {
    await prisma.taskStep.updateMany({ where: { id: { in: held } }, data: { status: "waiting-check" } })
    return { kind: "wait", why: `${held.length} held check${held.length === 1 ? "" : "s"} now wait${held.length === 1 ? "s" : ""} for you` }
  }
  const st = ph.steps.find((x) => x.status !== "done" && x.status !== "check-later")
  if (!st) {
    await prisma.taskPhase.update({ where: { id: ph.id }, data: { status: "done" } })
    const left = s.phases.filter((p) => p.id !== ph.id && p.status !== "done").length
    if (!left) await prisma.task.updateMany({ where: { id: s.id, status: "in-progress" }, data: { status: "done", runnerNote: "" } })
    return { kind: "wait", why: left ? `phase ${ph.number} is done` : "the task is done" }
  }
  const at = `${ph.number}.${st.number}`
  if (st.status === "waiting-check") return { kind: "wait", why: `step ${at} waits for your check` }
  if (st.status === "blocked") { await block(s.id); return { kind: "wait", why: `step ${at} is blocked` } }
  if (st.status === "verifying" || st.status === "deploying") return { kind: "verify", stepId: st.id }
  const ended = await prisma.taskJob.count({ where: { stepId: st.id, state: "done", note: NOFINISH } })
  if (ended >= STEP_SESSIONS) {
    await prisma.taskStep.update({ where: { id: st.id }, data: { status: "blocked", result: addLine(st.result, `MAW: ${STEP_SESSIONS} sessions ended without step_finish.`) } })
    await block(s.id)
    return { kind: "wait", why: `step ${at} is blocked` }
  }
  if (!s.branch) {
    const why = "This task has no branch. MAW changes files only on the task's own branch: give it one here, then create it with your command button."
    await noteRunner(s, why)
    return { kind: "wait", why }
  }
  const seen = branchChecks.get(s.id)
  let problem = seen && Date.now() - seen.at < BRANCH_CHECK_MS ? seen.problem : undefined
  if (problem === undefined) {
    problem = await branchProblem(s.projectId, s.branch)
    branchChecks.set(s.id, { at: Date.now(), problem })
  }
  await noteRunner(s, problem ?? "")
  if (problem) return { kind: "wait", why: problem }
  return { kind: "start", job: "step", phaseId: ph.id, phaseNumber: ph.number, stepId: st.id, stepNumber: st.number }
}

const addLine = (text: string, line: string) => `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`

/** After step_finish done: the verify commands, the deploy when needed, the
 *  changes, then done / waiting-check / blocked. Safe to run again (restart). */
async function finishStep(stepId: string, log: Log): Promise<string> {
  const st = await prisma.taskStep.findUniqueOrThrow({ where: { id: stepId }, include: { phase: { include: { task: true, steps: true } } } })
  const task = st.phase.task
  const at = `${st.phase.number}.${st.number}`
  // Other steps of the phase still to run (held or waiting checks are not).
  const othersLeft = st.phase.steps.some((x) => x.id !== st.id && !["done", "check-later", "waiting-check"].includes(x.status))
  // A check held to the phase's end while other steps still run: no deploy for
  // it now (the phase's last step deploys). The last step to run is never held.
  const held = st.check && task.checksAtEnd && othersLeft
  await prisma.taskStep.update({ where: { id: st.id }, data: { status: "verifying" } })
  log(`task ${task.number}: step ${at}: running the verify commands`)
  const v = await runVerify(task.projectId, heartbeat)
  // Deploy (MAW runs it, never the model) before a check, after a step marked
  // deploy, and when this is the phase's last step (held checks wait for it).
  const last = !othersLeft
  let dep: { ok: boolean; output: string } | null = null
  if (v.ok && ((st.check && !held) || st.deploy || last)) {
    await prisma.taskStep.update({ where: { id: st.id }, data: { status: "deploying" } })
    log(`task ${task.number}: step ${at}: running the deploy command`)
    dep = await runDeploy(task.projectId, heartbeat)
  }
  const diff = await projectChanges(task.projectId, heartbeat)
  const ok = v.ok && (dep?.ok ?? true)
  const outputs = { verifyOutput: v.output, diff, deployOutput: dep?.output ?? "" }
  if (ok) {
    await prisma.taskStep.update({ where: { id: st.id }, data: { status: held ? "check-later" : st.check ? "waiting-check" : "done", repairReason: "", ...outputs } })
    const note = `verified${dep ? " and deployed" : ""}${held ? "; its check is held to the phase end" : st.check ? "; waiting for your check" : ""}`
    log(`task ${task.number}: step ${at}: ${note}`)
    return note
  }
  // Failed: what the next session must fix, with the failing output.
  const what = !v.ok ? `the verify command failed: ${v.failed}` : "the deploy command failed"
  const reason = `MAW: ${what}.\n\n${tail(!v.ok ? v.output : dep!.output)}`
  if (st.repairs < REPAIRS) {
    const n = st.repairs + 1
    await prisma.taskStep.update({
      where: { id: st.id },
      data: { status: "in-progress", repairs: n, repairReason: reason, result: addLine(st.result, `MAW: ${what}; repair ${n} of ${REPAIRS} follows.`), ...outputs },
    })
    const note = `${!v.ok ? `verify failed: ${v.failed}` : "deploy failed"}; repair ${n} of ${REPAIRS} next`
    log(`task ${task.number}: step ${at}: ${note}`)
    return note
  }
  await prisma.taskStep.update({
    where: { id: st.id },
    data: { status: "blocked", repairReason: reason, result: addLine(st.result, `MAW: ${what}${st.repairs ? ` (after ${st.repairs} repair${st.repairs === 1 ? "" : "s"})` : ""}.`), ...outputs },
  })
  await block(task.id)
  const note = `${!v.ok ? `verify failed: ${v.failed}` : "deploy failed"}; blocked`
  log(`task ${task.number}: step ${at}: ${note}`)
  return note
}

/** The end of a command's output (where its error is), for the repair session's prompt. */
function tail(output: string, lines = 80, chars = 6000): string {
  return output.trim().split("\n").slice(-lines).join("\n").slice(-chars)
}

async function nextFinding(taskId: string) {
  const last = await prisma.taskFinding.findFirst({ where: { taskId }, orderBy: { position: "desc" }, select: { position: true } })
  return (last?.position ?? 0) + 1
}

// ---- starting a job -----------------------------------------------------------------

/** Clears what an earlier, unfinished attempt at the same pass left behind. */
async function prepare(s: FullTask, kind: JobKind, phaseId?: string) {
  if (kind === "task-checklist") {
    await prisma.taskFinding.deleteMany({ where: { taskId: s.id, phaseId: null } })
    await prisma.taskItem.deleteMany({ where: { taskId: s.id, phaseId: null } })
  }
  if (kind === "task-phases") {
    await prisma.taskPhase.deleteMany({ where: { taskId: s.id } })
    await prisma.task.update({ where: { id: s.id }, data: { overview: "", outOfScope: "", notes: "" } })
  }
  // Your direction (an item you answered when you started the planning) is kept.
  if (kind === "phase-checklist" && phaseId) {
    await prisma.taskFinding.deleteMany({ where: { phaseId } })
    await prisma.taskItem.deleteMany({ where: { phaseId, answer: null } })
  }
  if (kind === "phase-steps" && phaseId) await prisma.taskStep.deleteMany({ where: { phaseId } })
}

function jobTitle(s: FullTask, a: Extract<Action, { kind: "start" }>): string {
  const t = s.title.length > 48 ? `${s.title.slice(0, 47)}…` : s.title
  if (a.job === "task-checklist") return `${t} · checklist`
  if (a.job === "task-item") return `${t} · item ${a.position}`
  if (a.job === "phase-checklist") return `${t} · phase ${a.phaseNumber} checklist`
  if (a.job === "phase-item") return `${t} · phase ${a.phaseNumber} item ${a.position}`
  if (a.job === "phase-steps") return `${t} · phase ${a.phaseNumber} steps`
  if (a.job === "step") {
    const r = s.phases.find((p) => p.id === a.phaseId)?.steps.find((x) => x.id === a.stepId)?.repairs ?? 0
    return `${t} · step ${a.phaseNumber}.${a.stepNumber}${r ? ` · repair ${r}` : ""}`
  }
  return `${t} · phases`
}

function promptFor(s: FullTask, a: Extract<Action, { kind: "start" }>): string {
  const ph = a.phaseId ? s.phases.find((p) => p.id === a.phaseId) : undefined
  if (a.job === "task-checklist") return checklistPrompt(s)
  if (a.job === "task-item") return itemPrompt(s, s.items.find((q) => q.id === a.itemId)!)
  if (a.job === "task-phases") return phasesPrompt(s)
  if (!ph) throw new Error(`no phase for ${a.job}`)
  if (a.job === "phase-checklist") return phaseChecklistPrompt(s, ph)
  if (a.job === "phase-item") return phaseItemPrompt(s, ph, ph.items.find((q) => q.id === a.itemId)!)
  if (a.job === "phase-steps") return phaseStepsPrompt(s, ph)
  if (a.job === "step") { const st = ph.steps.find((x) => x.id === a.stepId)!; return stepPrompt(s, ph, st, stepMd(ph, st)) }
  throw new Error(`the runner does not start ${a.job} sessions yet`)
}

async function fail(taskId: string, kind: string, note: string, sessionId?: string, itemId?: string, phaseId?: string) {
  if (sessionId) {
    await prisma.taskJob.update({ where: { sessionId }, data: { state: "failed", note: note.slice(0, 2000), endedAt: new Date() } })
  } else {
    // No session could be started: a job row records why, with a stand-in id.
    await prisma.taskJob.create({
      data: { taskId, kind, itemId, phaseId, sessionId: `none-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, state: "failed", note: note.slice(0, 2000), endedAt: new Date() },
    })
  }
  await block(taskId)
}

/** Blocked (or paused) remembers where Retry (or Resume) goes back to. */
async function block(taskId: string) {
  const st = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } })
  if (st && (st.status === "planning" || st.status === "in-progress")) {
    await prisma.task.updateMany({ where: { id: taskId, status: st.status }, data: { status: "blocked", resumeTo: st.status } })
  }
}

export async function startJob(s: FullTask, a: Extract<Action, { kind: "start" }>, log: Log) {
  await prepare(s, a.job, a.phaseId)
  const fresh = (await getTask(s.id))!
  const prompt = promptFor(fresh, a)
  const title = jobTitle(fresh, a)
  const ss = await startSession(s.projectId, null, title)
  if (!ss.ok) { log(`task ${s.number}: ${title}: no session: ${ss.message}`); await fail(s.id, a.job, `The session could not be started: ${ss.message}`, undefined, a.itemId, a.phaseId); return }
  await prisma.taskJob.create({ data: { taskId: s.id, kind: a.job, itemId: a.itemId ?? null, phaseId: a.phaseId ?? null, stepId: a.stepId ?? null, sessionId: ss.session.id } })
  if (a.job === "step") await prisma.taskStep.updateMany({ where: { id: a.stepId, status: "pending" }, data: { status: "in-progress" } })
  const pr = await ocPrompt(ss.session.directory, ss.session.id, prompt)
  if (!pr.ok) { log(`task ${s.number}: ${title}: prompt not sent: ${pr.message}`); await fail(s.id, a.job, `The prompt could not be sent: ${pr.message}`, ss.session.id); return }
  log(`task ${s.number}: started ${title} (${ss.session.id}, prompt ${prompt.length} characters)`)
}

// ---- watching a job to its end ----------------------------------------------------------

function errorText(e: unknown): string {
  if (!e || typeof e !== "object") return String(e)
  const o = e as { name?: string; data?: { message?: string } }
  return o.data?.message || o.name || JSON.stringify(e).slice(0, 300)
}

/** The session's token use from OpenCode: its context at the end, and the tokens generated. Best effort. */
export async function recordTokens(directory: string, jobId: string, sessionId: string) {
  const ms = await ocMessages(directory, sessionId).catch(() => null)
  if (!ms?.ok) return
  const used = ms.data.filter((m) => m.info.role === "assistant" && m.info.tokens).map((m) => m.info.tokens!)
  if (!used.length) return
  const t = used.at(-1)!
  await prisma.taskJob.update({
    where: { id: jobId },
    data: { contextTokens: t.input + t.cache.read + t.cache.write + t.output, outputTokens: used.reduce((n, u) => n + u.output + u.reasoning, 0) },
  }).catch(() => {})
}

async function end(job: Job, state: "done" | "failed" | "stopped", note: string, log: Log) {
  await recordTokens(workspacePath(job.task.project.slug), job.id, job.sessionId)
  const where = job.phase ? (job.item ? ` ${job.phase.number}.${job.item.position}` : job.step ? ` ${job.phase.number}.${job.step.number}` : ` (phase ${job.phase.number})`)
    : job.item ? ` ${job.item.position}` : ""
  log(`task ${job.task.number}: ${JOB_LABEL[job.kind] ?? job.kind}${where} ${state}${note ? `: ${note}` : ""}`)
  if (state === "failed") { await fail(job.taskId, job.kind, note, job.sessionId); return }
  await prisma.taskJob.update({ where: { id: job.id }, data: { state, note: (note || job.note).slice(0, 2000), endedAt: new Date() } })
}

/** What a finished session left, checked against what its kind must leave. */
async function settle(job: Job, log: Log) {
  if (job.kind === "task-checklist") {
    const n = await prisma.taskItem.count({ where: { taskId: job.taskId, phaseId: null } })
    if (!n) return end(job, "failed", "The session ended without adding any checklist items.", log)
    return end(job, "done", `${n} checklist item${n === 1 ? "" : "s"}`, log)
  }
  if ((job.kind === "task-item" || job.kind === "phase-item") && job.itemId) {
    const q = await prisma.taskItem.findUnique({ where: { id: job.itemId }, select: { checked: true } })
    return end(job, "done", q?.checked ? "answered" : "left open for the next session", log)
  }
  if (job.kind === "task-phases") {
    const n = await prisma.taskPhase.count({ where: { taskId: job.taskId } })
    if (!n) return end(job, "failed", "The session ended without adding any phases.", log)
    await end(job, "done", `${n} phase${n === 1 ? "" : "s"}`, log)
    await prisma.task.updateMany({ where: { id: job.taskId, status: "planning" }, data: { status: "phases-ready" } })
    return
  }
  if (job.kind === "phase-checklist" && job.phaseId) {
    const n = await prisma.taskItem.count({ where: { phaseId: job.phaseId, answer: null } })
    return end(job, "done", n ? `${n} checklist item${n === 1 ? "" : "s"}` : "nothing to add", log)
  }
  if (job.kind === "phase-steps" && job.phaseId) {
    const n = await prisma.taskStep.count({ where: { phaseId: job.phaseId } })
    if (!n) return end(job, "failed", "The session ended without adding any steps.", log)
    await end(job, "done", `${n} step${n === 1 ? "" : "s"}`, log)
    await prisma.taskPhase.updateMany({ where: { id: job.phaseId, status: "planning" }, data: { status: "steps-ready" } })
    return
  }
  if (job.kind === "step" && job.stepId) {
    const st = await prisma.taskStep.findUnique({ where: { id: job.stepId }, select: { status: true } })
    if (st?.status === "done" || st?.status === "verifying" || st?.status === "deploying") {
      const note = await finishStep(job.stepId, log)
      return end(job, "done", job.note ? `${job.note.slice(0, 1500)} · ${note}` : note, log)
    }
    if (st?.status === "blocked") { await end(job, "done", job.note || "blocked", log); await block(job.taskId); return }
    return end(job, "done", NOFINISH, log)
  }
  return end(job, "done", "", log)
}

/** Whether the task (and phase) are still where this job's kind runs. */
function stillWanted(job: Job): string | null {
  const st = job.task.status
  if (job.kind.startsWith("task-")) return st === "planning" ? null : `The task is ${st}.`
  if (st !== "in-progress") return `The task is ${st}.`
  if (job.kind.startsWith("phase-") && job.phase?.status !== "planning") return `Phase ${job.phase?.number} is ${job.phase?.status ?? "gone"}.`
  if (job.kind === "step" && job.phase?.status !== "in-progress") return `Phase ${job.phase?.number} is ${job.phase?.status ?? "gone"}.`
  return null
}

export async function checkJob(job: Job, log: Log, now = Date.now()) {
  const dir = workspacePath(job.task.project.slug)
  const age = now - job.createdAt.getTime()
  const gone = stillWanted(job)
  if (gone) {
    await ocAbort(dir, job.sessionId)
    return end(job, "stopped", gone, log)
  }
  const st = await ocStatus(dir, 10_000)
  if (!st.ok) { log(`OpenCode: ${st.message}`); return }
  // The prompt says not to; a question would hold the session forever.
  const qs = await ocQuestions(dir, 10_000)
  for (const q of qs.ok ? qs.data.filter((x) => x.sessionID === job.sessionId) : []) {
    log(`task ${job.task.number}: the session put a question; refused (planning sessions record questions as checklist items)`)
    await ocQuestionReject(dir, q.id)
  }
  const t = st.data[job.sessionId]?.type
  if (t === "busy" || t === "retry") {
    if (age > JOB_LIMIT_MS) { await ocAbort(dir, job.sessionId); return end(job, "failed", `The session ran over ${JOB_LIMIT_MS / 60_000} minutes and was stopped.`, log) }
    return
  }
  const ms = await ocMessages(dir, job.sessionId, 4)
  if (!ms.ok) { log(`OpenCode: ${ms.message}`); return }
  const last = ms.data.at(-1)
  if (!last || last.info.role !== "assistant" || !last.info.time.completed) {
    if (age < START_GRACE_MS) return
    return end(job, "failed", "The model did not answer (is llama.cpp running?).", log)
  }
  if (last.info.error) return end(job, "failed", `The session ended with an error: ${errorText(last.info.error)}`, log)
  return settle(job, log)
}

// ---- the loop's one turn ------------------------------------------------------------------

/** One turn: watch the running job, or start the next one. `projectId`
 *  keeps a self-test to its own project (the service passes none). */
export async function runnerTick(log: Log, projectId?: string): Promise<"busy" | "started" | "idle"> {
  if (!projectId) heartbeat()
  const job = await runningJob(projectId)
  if (job) { await checkJob(job, log); return "busy" }
  const tasks = await prisma.task.findMany({ where: { status: { in: ["planning", "in-progress", "phases-ready"] }, ...(projectId ? { projectId } : {}) }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, approve: true, number: true } })
  for (const t of tasks) {
    if (t.status === "phases-ready") {
      // Hands-off: MAW approves the phases as you would.
      if (t.approve === "all" && (await approvePhases(t.id)).ok) log(`task ${t.number}: phases approved by MAW (hands-off)`)
      continue
    }
    const id = t.id
    const s = await getTask(id)
    if (!s || (s.status !== "planning" && s.status !== "in-progress")) continue
    const a = s.status === "planning" ? await planningAction(s) : await phaseAction(s)
    if (a.kind === "wait") continue
    if (a.kind === "verify") { await finishStep(a.stepId, log); return "started" }
    await startJob(s, a, log)
    return "started"
  }
  return "idle"
}

// ---- what the developer does on the Dashboard ----------------------------------------------

/** Stops the task's running session (if any); the job is marked stopped. */
export async function stopTaskJobs(taskId: string, why: string) {
  const jobs = await prisma.taskJob.findMany({ where: { taskId, state: "running" }, include: { task: { include: { project: true } } } })
  for (const j of jobs) {
    await ocAbort(workspacePath(j.task.project.slug), j.sessionId)
    await recordTokens(workspacePath(j.task.project.slug), j.id, j.sessionId)
    await prisma.taskJob.update({ where: { id: j.id }, data: { state: "stopped", note: why, endedAt: new Date() } })
  }
}

type R = { ok: true } | { ok: false; message: string }
async function move(taskId: string, from: string[], to: string, data: { resumeTo?: string | null } = {}): Promise<R> {
  const r = await prisma.task.updateMany({ where: { id: taskId, status: { in: from } }, data: { status: to, ...data } })
  return r.count ? { ok: true } : { ok: false, message: "The task has moved on; the page shows its state now." }
}
const DIRECTION_MAX = 4000

export async function pauseTask(taskId: string): Promise<R> {
  const st = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } })
  if (!st || (st.status !== "planning" && st.status !== "in-progress")) return { ok: false, message: "Only a task that MAW is working on can be paused." }
  const r = await move(taskId, [st.status], "paused", { resumeTo: st.status })
  if (r.ok) await stopTaskJobs(taskId, "Paused by you.")
  return r
}
/** Resume (paused) or Retry (blocked): the task goes back to where it was. */
export async function resumeTask(taskId: string): Promise<R> {
  const st = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true, resumeTo: true } })
  if (!st || (st.status !== "paused" && st.status !== "blocked")) return { ok: false, message: "The task has moved on; the page shows its state now." }
  return move(taskId, [st.status], st.resumeTo === "in-progress" ? "in-progress" : "planning", { resumeTo: null })
}
export const approvePhases = (taskId: string) => move(taskId, ["phases-ready"], "in-progress")

/** Adds your direction as an answered item on the task (phaseId null) or phase checklist. */
async function addDirection(taskId: string, phaseId: string | null, text: string, d: string) {
  const last = await prisma.taskItem.findFirst({ where: { taskId, phaseId }, orderBy: { position: "desc" }, select: { position: true } })
  await prisma.taskItem.create({
    data: { taskId, phaseId, position: (last?.position ?? 0) + 1, text, developer: true, answer: d, checked: true, checkedAt: new Date() },
  })
}

/** Plans the phases again; your direction (optional) is kept as an answered item the next plan reads. */
export async function replanPhases(taskId: string, direction: string): Promise<R> {
  const d = direction.trim()
  if (d.length > DIRECTION_MAX) return { ok: false, message: "Keep the direction under 4,000 characters." }
  const r = await move(taskId, ["phases-ready"], "planning")
  if (r.ok && d) await addDirection(taskId, null, "Your direction for the phases", d)
  return r
}

/** The task's current phase, checked against what the button expects. */
async function phaseFor(phaseId: string, status: string) {
  const ph = await prisma.taskPhase.findUnique({ where: { id: phaseId }, include: { task: { include: { phases: { orderBy: { number: "asc" } } } } } })
  if (!ph) return { ok: false as const, message: "This phase no longer exists." }
  if (ph.task.status !== "in-progress") return { ok: false as const, message: `The task is ${ph.task.status}; the phases are approved and worked only while it is in progress.` }
  const cur = currentPhase(ph.task)
  if (cur?.id !== ph.id) return { ok: false as const, message: `Phase ${cur?.number ?? "?"} comes first; phases are planned one at a time, in order.` }
  if (ph.status !== status) return { ok: false as const, message: "The phase has moved on; the page shows its state now." }
  return { ok: true as const, ph }
}

/** Starts planning the current phase into steps; your direction (optional) is read by every session. */
export async function planPhase(phaseId: string, direction: string): Promise<R> {
  const d = direction.trim()
  if (d.length > DIRECTION_MAX) return { ok: false, message: "Keep the direction under 4,000 characters." }
  const f = await phaseFor(phaseId, "pending")
  if (!f.ok) return f
  const r = await prisma.taskPhase.updateMany({ where: { id: phaseId, status: "pending" }, data: { status: "planning" } })
  if (!r.count) return { ok: false, message: "The phase has moved on; the page shows its state now." }
  if (d) await addDirection(f.ph.taskId, phaseId, `Your direction for phase ${f.ph.number}'s steps`, d)
  return { ok: true }
}

/** The steps are approved: the phase is in progress (its steps are carried out next). */
export async function approveSteps(phaseId: string): Promise<R> {
  const f = await phaseFor(phaseId, "steps-ready")
  if (!f.ok) return f
  const r = await prisma.taskPhase.updateMany({ where: { id: phaseId, status: "steps-ready" }, data: { status: "in-progress" } })
  return r.count ? { ok: true } : { ok: false, message: "The phase has moved on; the page shows its state now." }
}

/** Plans the phase's steps again (its checklist is kept); your direction (optional) is read by the next plan. */
export async function replanSteps(phaseId: string, direction: string): Promise<R> {
  const d = direction.trim()
  if (d.length > DIRECTION_MAX) return { ok: false, message: "Keep the direction under 4,000 characters." }
  const f = await phaseFor(phaseId, "steps-ready")
  if (!f.ok) return f
  const r = await prisma.taskPhase.updateMany({ where: { id: phaseId, status: "steps-ready" }, data: { status: "planning" } })
  if (!r.count) return { ok: false, message: "The phase has moved on; the page shows its state now." }
  if (d) await addDirection(f.ph.taskId, phaseId, `Your direction for phase ${f.ph.number}'s steps`, d)
  return { ok: true }
}

/** The step, checked to be the current phase's current step in a task MAW is working on. */
async function stepFor(stepId: string, statuses: string[]) {
  const st = await prisma.taskStep.findUnique({ where: { id: stepId }, include: { phase: { include: { task: { include: { phases: { orderBy: { number: "asc" } } } } } } } })
  if (!st) return { ok: false as const, message: "This step no longer exists." }
  const task = st.phase.task
  if (task.status !== "in-progress" && task.status !== "blocked") return { ok: false as const, message: `The task is ${task.status}.` }
  if (currentPhase(task)?.id !== st.phaseId || st.phase.status !== "in-progress") return { ok: false as const, message: "This step's phase is not the one being worked on." }
  if (!statuses.includes(st.status)) return { ok: false as const, message: "The step has moved on; the page shows its state now." }
  return { ok: true as const, st, task }
}
async function unblock(taskId: string) {
  await prisma.task.updateMany({ where: { id: taskId, status: "blocked" }, data: { status: "in-progress", resumeTo: null } })
}

/** Your manual check of a step marked Check: right → done; not right → the step runs again with your note. */
export async function checkStep(stepId: string, right: boolean, note: string): Promise<R> {
  const n = note.trim()
  if (!right && !n) return { ok: false, message: "Say what is not right; the next session reads it." }
  if (n.length > DIRECTION_MAX) return { ok: false, message: "Keep the note under 4,000 characters." }
  const f = await stepFor(stepId, ["waiting-check"])
  if (!f.ok) return f
  await prisma.taskStep.update({
    where: { id: stepId },
    data: right ? { status: "done", result: addLine(f.st.result, `Developer checked it${n ? `: ${n}` : "."}`) } : { status: "pending", repairs: 0, repairReason: "", result: addLine(f.st.result, `Developer: not right: ${n}`) },
  })
  return { ok: true }
}

/** A blocked step runs again (your direction, optional, is read by the next session). */
export async function retryStep(stepId: string, direction: string): Promise<R> {
  const d = direction.trim()
  if (d.length > DIRECTION_MAX) return { ok: false, message: "Keep the direction under 4,000 characters." }
  const f = await stepFor(stepId, ["blocked"])
  if (!f.ok) return f
  await prisma.taskJob.updateMany({ where: { stepId, note: NOFINISH }, data: { note: `${NOFINISH} (before your retry)` } })
  // Your Try again gives MAW its repairs again; the failing output stays for the next session.
  await prisma.taskStep.update({ where: { id: stepId }, data: { status: "pending", repairs: 0, result: d ? addLine(f.st.result, `Developer: ${d}`) : f.st.result } })
  await unblock(f.task.id)
  return { ok: true }
}

/** You did (or checked) the step yourself: it is done, and the task goes on. */
export async function markStepDone(stepId: string): Promise<R> {
  const f = await stepFor(stepId, ["blocked", "waiting-check"])
  if (!f.ok) return f
  await prisma.taskStep.update({ where: { id: stepId }, data: { status: "done", result: addLine(f.st.result, "Developer marked it done.") } })
  await unblock(f.task.id)
  return { ok: true }
}

/** The task's branch, set from the Dashboard (a task without one runs no step). */
export async function setTaskBranch(taskId: string, branch: string): Promise<R> {
  const b = branch.trim()
  if (!b) return { ok: false, message: "Give the branch a name, for example task-1-tool-count." }
  const e = checkTaskInput({ title: "x", request: "x", branch: b })
  if (e.branch) return { ok: false, message: e.branch }
  const r = await prisma.task.updateMany({ where: { id: taskId }, data: { branch: b, runnerNote: "" } })
  branchChecks.delete(taskId)
  return r.count ? { ok: true } : { ok: false, message: "This task no longer exists." }
}

/** A done step is opened again with your note: it runs again (its phase and the task too). */
export async function reopenStep(stepId: string, note: string): Promise<R> {
  const n = note.trim()
  if (!n) return { ok: false, message: "Say what is wrong; the step's next session reads it." }
  if (n.length > DIRECTION_MAX) return { ok: false, message: "Keep the note under 4,000 characters." }
  const st = await prisma.taskStep.findUnique({ where: { id: stepId }, include: { phase: { include: { task: { include: { phases: { orderBy: { number: "asc" } } } } } } } })
  if (!st) return { ok: false, message: "This step no longer exists." }
  const task = st.phase.task
  if (st.status !== "done") return { ok: false, message: "Only a done step can be reopened." }
  if (!["in-progress", "done", "blocked", "paused"].includes(task.status)) return { ok: false, message: `The task is ${task.status}.` }
  // The phase being worked on, or (when every phase is done) the last phase.
  const cur = currentPhase(task) ?? task.phases.at(-1)
  if (cur?.id !== st.phaseId) return { ok: false, message: "Only a step of the phase being worked on (or of the last phase, when the task is done) can be reopened." }
  await prisma.taskStep.update({ where: { id: st.id }, data: { status: "pending", repairs: 0, repairReason: "", result: addLine(st.result, `Developer: reopened: ${n}`) } })
  await prisma.taskPhase.update({ where: { id: st.phaseId }, data: { status: "in-progress" } })
  if (task.status === "done") await prisma.task.update({ where: { id: task.id }, data: { status: "in-progress" } })
  return { ok: true }
}
