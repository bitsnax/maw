import { mkdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { prisma } from "./prisma"
import { getStory, type FullStory } from "./stories"
import { startSession } from "./sessions"
import { workspacePath } from "./workspace"
import { WORKSPACES } from "./tools"
import { ocAbort, ocMessages, ocPrompt, ocQuestionReject, ocQuestions, ocStatus } from "./opencode"
import { checklistPrompt, itemPrompt, phaseChecklistPrompt, phaseItemPrompt, phaseStepsPrompt, phasesPrompt, stepPrompt } from "./story-prompts"
import { stepMd, type JobKind } from "./story-tools"
import { branchProblem, projectChanges, runVerify } from "./story-steps"

// The runner: MAW's own loop (scripts/runner.ts, the maw-runner service) that
// carries stories forward one model session at a time. All its state is in
// the database (story status, story_job rows), so it can stop and start at
// any moment: a running job is picked up again and watched to its end.
// One job at a time across MAW (llama.cpp has one slot).
//
// Story planning (a story in status "planning"):
//   1. story-checklist  the questions the plan needs     → story checklist items
//   2. story-item       one session per open item         → findings, item checked
//      (an item still open after ITEM_SESSIONS sessions is handed to the developer)
//   3. wait while items marked for the developer are open (answered on the Dashboard)
//   4. story-phases     the overview and the phases       → status "phases-ready"
// Phase planning (a story "in-progress", its first phase that is not done):
//   pending        waits for you: "Plan steps" (with a direction, optional)
//   planning       phase-checklist (may add nothing) → phase-item per open item
//                  → wait for your items → phase-steps → phase "steps-ready"
//   steps-ready    waits for you: Approve steps (→ phase "in-progress") or Plan again
//   in-progress    its steps are carried out, one session each, in order:
//                    pending → (branch check) step session → step_finish
//                    → MAW runs the verify commands and records git status/diff
//                    → done, or "waiting-check" (a step marked Check: you check it),
//                    or blocked (the step said so, the verify failed, or
//                    STEP_SESSIONS sessions ended without step_finish)
//                  when every step is done the phase is done; the next phase
//                  waits for Plan steps; the last phase done → story done.
// A session that fails (model error, no answer, nothing recorded) sets the
// story to "blocked" with the reason on its job; Retry on the Dashboard
// returns it to where it was (story.resumeTo), as Resume does after Pause.

export const ITEM_SESSIONS = 3
/** Sessions on one step that may end without step_finish before it is blocked. */
export const STEP_SESSIONS = 3
const NOFINISH = "ended without step_finish; the next session continues from its notes"
/** A session longer than this is stopped and counts as failed. */
export const JOB_LIMIT_MS = 60 * 60_000
/** Time a session gets to start answering before it counts as failed. */
export const START_GRACE_MS = 120_000

export const JOB_LABEL: Record<string, string> = {
  "story-checklist": "Story checklist", "story-item": "Checklist item", "story-phases": "Story plan and phases",
  "phase-checklist": "Phase checklist", "phase-item": "Phase checklist item", "phase-steps": "Phase steps", step: "Step",
}

type Log = (line: string) => void
type Job = NonNullable<Awaited<ReturnType<typeof runningJob>>>
type Action =
  | { kind: "start"; job: JobKind; itemId?: string; position?: number; phaseId?: string; phaseNumber?: number; stepId?: string; stepNumber?: number }
  | { kind: "verify"; stepId: string }
  | { kind: "wait"; why: string }

const runningJob = (projectId?: string) => prisma.storyJob.findFirst({
  where: { state: "running", ...(projectId ? { story: { projectId } } : {}) }, orderBy: { createdAt: "asc" },
  include: { story: { include: { project: true } }, item: { select: { position: true } }, phase: { select: { number: true, status: true } }, step: { select: { number: true } } },
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

// ---- what a story needs next ------------------------------------------------------

/** The next thing story planning needs. May hand an item to the developer. */
export async function planningAction(s: FullStory): Promise<Action> {
  const jobs = await prisma.storyJob.findMany({ where: { storyId: s.id, phaseId: null }, select: { kind: true, state: true, itemId: true } })
  if (!jobs.some((j) => j.kind === "story-checklist" && j.state === "done")) return { kind: "start", job: "story-checklist" }
  const next = await nextItem(s.id, s.items, jobs)
  if (next) return { kind: "start", job: "story-item", itemId: next.id, position: next.position }
  const open = await prisma.storyItem.count({ where: { storyId: s.id, phaseId: null, checked: false } })
  if (open) return { kind: "wait", why: `${open} checklist item${open === 1 ? "" : "s"} for you` }
  return { kind: "start", job: "story-phases" }
}

/** The first open item the agent should take (handing to the developer any it left open ITEM_SESSIONS times). */
async function nextItem(storyId: string, items: { id: string; position: number; checked: boolean; developer: boolean }[], jobs: { state: string; itemId: string | null }[]) {
  for (const q of items) {
    if (q.checked || q.developer) continue
    const tried = jobs.filter((j) => j.itemId === q.id && j.state === "done").length
    if (tried < ITEM_SESSIONS) return q
    // Still open after ITEM_SESSIONS sessions: the developer answers it.
    await prisma.storyItem.update({ where: { id: q.id }, data: { developer: true } })
    const it = await prisma.storyItem.findUniqueOrThrow({ where: { id: q.id }, select: { phaseId: true } })
    await prisma.storyFinding.create({
      data: {
        storyId, phaseId: it.phaseId, itemId: q.id, position: await nextFinding(storyId), heading: "Handed to you",
        body: `The agent left this item open after ${ITEM_SESSIONS} sessions. Answer it from what is known (see the findings), and planning goes on.`,
      },
    })
  }
  return null
}

/** The phase the story is at: its first phase that is not done. */
export function currentPhase<P extends { status: string }>(s: { phases: P[] }): P | null {
  return s.phases.find((p) => p.status !== "done") ?? null
}

/** The next thing phase planning needs (a story in progress). */
export async function phaseAction(s: FullStory): Promise<Action> {
  const ph = currentPhase(s)
  if (!ph) return { kind: "wait", why: "every phase is done" }
  if (ph.status === "in-progress") return stepAction(s, ph)
  if (ph.status !== "planning") return { kind: "wait", why: `phase ${ph.number} is ${ph.status}` }
  const jobs = await prisma.storyJob.findMany({ where: { phaseId: ph.id }, select: { kind: true, state: true, itemId: true } })
  const at = { phaseId: ph.id, phaseNumber: ph.number }
  if (!jobs.some((j) => j.kind === "phase-checklist" && j.state === "done")) return { kind: "start", job: "phase-checklist", ...at }
  const next = await nextItem(s.id, ph.items, jobs)
  if (next) return { kind: "start", job: "phase-item", itemId: next.id, position: next.position, ...at }
  const open = await prisma.storyItem.count({ where: { phaseId: ph.id, checked: false } })
  if (open) return { kind: "wait", why: `${open} phase checklist item${open === 1 ? "" : "s"} for you` }
  return { kind: "start", job: "phase-steps", ...at }
}

// ---- steps --------------------------------------------------------------------------

const branchChecks = new Map<string, { at: number; problem: string | null }>()
const BRANCH_CHECK_MS = 20_000
/** Self-tests: check the branch again at once. */
export function forgetBranchChecks() { branchChecks.clear() }

async function noteRunner(s: FullStory, note: string) {
  if (s.runnerNote !== note) await prisma.story.update({ where: { id: s.id }, data: { runnerNote: note } })
}

/** The next thing a phase in progress needs: its first step that is not done. */
async function stepAction(s: FullStory, ph: FullStory["phases"][number]): Promise<Action> {
  const st = ph.steps.find((x) => x.status !== "done")
  if (!st) {
    await prisma.storyPhase.update({ where: { id: ph.id }, data: { status: "done" } })
    const left = s.phases.filter((p) => p.id !== ph.id && p.status !== "done").length
    if (!left) await prisma.story.updateMany({ where: { id: s.id, status: "in-progress" }, data: { status: "done", runnerNote: "" } })
    return { kind: "wait", why: left ? `phase ${ph.number} is done` : "the story is done" }
  }
  const at = `${ph.number}.${st.number}`
  if (st.status === "waiting-check") return { kind: "wait", why: `step ${at} waits for your check` }
  if (st.status === "blocked") { await block(s.id); return { kind: "wait", why: `step ${at} is blocked` } }
  if (st.status === "verifying") return { kind: "verify", stepId: st.id }
  const ended = await prisma.storyJob.count({ where: { stepId: st.id, state: "done", note: NOFINISH } })
  if (ended >= STEP_SESSIONS) {
    await prisma.storyStep.update({ where: { id: st.id }, data: { status: "blocked", result: addLine(st.result, `MAW: ${STEP_SESSIONS} sessions ended without step_finish.`) } })
    await block(s.id)
    return { kind: "wait", why: `step ${at} is blocked` }
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

/** After step_finish done: the verify commands, the changes, then done / waiting-check / blocked. */
async function finishStep(stepId: string, log: Log): Promise<string> {
  const st = await prisma.storyStep.findUniqueOrThrow({ where: { id: stepId }, include: { phase: { include: { story: true } } } })
  const story = st.phase.story
  const at = `${st.phase.number}.${st.number}`
  await prisma.storyStep.update({ where: { id: st.id }, data: { status: "verifying" } })
  log(`story ${story.number}: step ${at}: running the verify commands`)
  const v = await runVerify(story.projectId, heartbeat)
  const diff = await projectChanges(story.projectId, heartbeat)
  const status = !v.ok ? "blocked" : st.check ? "waiting-check" : "done"
  await prisma.storyStep.update({
    where: { id: st.id },
    data: { status, verifyOutput: v.output, diff, ...(v.ok ? {} : { result: addLine(st.result, `MAW: the verify command failed: ${v.failed}`) }) },
  })
  if (!v.ok) await block(story.id)
  const note = v.ok ? (st.check ? "verified; waiting for your check" : "verified") : `verify failed: ${v.failed}`
  log(`story ${story.number}: step ${at}: ${note}`)
  return note
}

async function nextFinding(storyId: string) {
  const last = await prisma.storyFinding.findFirst({ where: { storyId }, orderBy: { position: "desc" }, select: { position: true } })
  return (last?.position ?? 0) + 1
}

// ---- starting a job -----------------------------------------------------------------

/** Clears what an earlier, unfinished attempt at the same pass left behind. */
async function prepare(s: FullStory, kind: JobKind, phaseId?: string) {
  if (kind === "story-checklist") {
    await prisma.storyFinding.deleteMany({ where: { storyId: s.id, phaseId: null } })
    await prisma.storyItem.deleteMany({ where: { storyId: s.id, phaseId: null } })
  }
  if (kind === "story-phases") {
    await prisma.storyPhase.deleteMany({ where: { storyId: s.id } })
    await prisma.story.update({ where: { id: s.id }, data: { overview: "", outOfScope: "", notes: "" } })
  }
  // Your direction (an item you answered when you started the planning) is kept.
  if (kind === "phase-checklist" && phaseId) {
    await prisma.storyFinding.deleteMany({ where: { phaseId } })
    await prisma.storyItem.deleteMany({ where: { phaseId, answer: null } })
  }
  if (kind === "phase-steps" && phaseId) await prisma.storyStep.deleteMany({ where: { phaseId } })
}

function jobTitle(s: FullStory, a: Extract<Action, { kind: "start" }>): string {
  if (a.job === "story-checklist") return `Story ${s.number} · checklist`
  if (a.job === "story-item") return `Story ${s.number} · item ${a.position}`
  if (a.job === "phase-checklist") return `Story ${s.number} · phase ${a.phaseNumber} checklist`
  if (a.job === "phase-item") return `Story ${s.number} · phase ${a.phaseNumber} item ${a.position}`
  if (a.job === "phase-steps") return `Story ${s.number} · phase ${a.phaseNumber} steps`
  if (a.job === "step") return `Story ${s.number} · step ${a.phaseNumber}.${a.stepNumber}`
  return `Story ${s.number} · phases`
}

function promptFor(s: FullStory, a: Extract<Action, { kind: "start" }>): string {
  const ph = a.phaseId ? s.phases.find((p) => p.id === a.phaseId) : undefined
  if (a.job === "story-checklist") return checklistPrompt(s)
  if (a.job === "story-item") return itemPrompt(s, s.items.find((q) => q.id === a.itemId)!)
  if (a.job === "story-phases") return phasesPrompt(s)
  if (!ph) throw new Error(`no phase for ${a.job}`)
  if (a.job === "phase-checklist") return phaseChecklistPrompt(s, ph)
  if (a.job === "phase-item") return phaseItemPrompt(s, ph, ph.items.find((q) => q.id === a.itemId)!)
  if (a.job === "phase-steps") return phaseStepsPrompt(s, ph)
  if (a.job === "step") { const st = ph.steps.find((x) => x.id === a.stepId)!; return stepPrompt(s, ph, st, stepMd(ph, st)) }
  throw new Error(`the runner does not start ${a.job} sessions yet`)
}

async function fail(storyId: string, kind: string, note: string, sessionId?: string, itemId?: string, phaseId?: string) {
  if (sessionId) {
    await prisma.storyJob.update({ where: { sessionId }, data: { state: "failed", note: note.slice(0, 2000), endedAt: new Date() } })
  } else {
    // No session could be started: a job row records why, with a stand-in id.
    await prisma.storyJob.create({
      data: { storyId, kind, itemId, phaseId, sessionId: `none-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, state: "failed", note: note.slice(0, 2000), endedAt: new Date() },
    })
  }
  await block(storyId)
}

/** Blocked (or paused) remembers where Retry (or Resume) goes back to. */
async function block(storyId: string) {
  const st = await prisma.story.findUnique({ where: { id: storyId }, select: { status: true } })
  if (st && (st.status === "planning" || st.status === "in-progress")) {
    await prisma.story.updateMany({ where: { id: storyId, status: st.status }, data: { status: "blocked", resumeTo: st.status } })
  }
}

export async function startJob(s: FullStory, a: Extract<Action, { kind: "start" }>, log: Log) {
  await prepare(s, a.job, a.phaseId)
  const fresh = (await getStory(s.id))!
  const prompt = promptFor(fresh, a)
  const title = jobTitle(fresh, a)
  const ss = await startSession(s.projectId, null, title)
  if (!ss.ok) { log(`story ${s.number}: ${title}: no session: ${ss.message}`); await fail(s.id, a.job, `The session could not be started: ${ss.message}`, undefined, a.itemId, a.phaseId); return }
  await prisma.storyJob.create({ data: { storyId: s.id, kind: a.job, itemId: a.itemId ?? null, phaseId: a.phaseId ?? null, stepId: a.stepId ?? null, sessionId: ss.session.id } })
  if (a.job === "step") await prisma.storyStep.updateMany({ where: { id: a.stepId, status: "pending" }, data: { status: "in-progress" } })
  const pr = await ocPrompt(ss.session.directory, ss.session.id, prompt)
  if (!pr.ok) { log(`story ${s.number}: ${title}: prompt not sent: ${pr.message}`); await fail(s.id, a.job, `The prompt could not be sent: ${pr.message}`, ss.session.id); return }
  log(`story ${s.number}: started ${title} (${ss.session.id}, prompt ${prompt.length} characters)`)
}

// ---- watching a job to its end ----------------------------------------------------------

function errorText(e: unknown): string {
  if (!e || typeof e !== "object") return String(e)
  const o = e as { name?: string; data?: { message?: string } }
  return o.data?.message || o.name || JSON.stringify(e).slice(0, 300)
}

async function end(job: Job, state: "done" | "failed" | "stopped", note: string, log: Log) {
  const where = job.phase ? (job.item ? ` ${job.phase.number}.${job.item.position}` : job.step ? ` ${job.phase.number}.${job.step.number}` : ` (phase ${job.phase.number})`)
    : job.item ? ` ${job.item.position}` : ""
  log(`story ${job.story.number}: ${JOB_LABEL[job.kind] ?? job.kind}${where} ${state}${note ? `: ${note}` : ""}`)
  if (state === "failed") { await fail(job.storyId, job.kind, note, job.sessionId); return }
  await prisma.storyJob.update({ where: { id: job.id }, data: { state, note: (note || job.note).slice(0, 2000), endedAt: new Date() } })
}

/** What a finished session left, checked against what its kind must leave. */
async function settle(job: Job, log: Log) {
  if (job.kind === "story-checklist") {
    const n = await prisma.storyItem.count({ where: { storyId: job.storyId, phaseId: null } })
    if (!n) return end(job, "failed", "The session ended without adding any checklist items.", log)
    return end(job, "done", `${n} checklist item${n === 1 ? "" : "s"}`, log)
  }
  if ((job.kind === "story-item" || job.kind === "phase-item") && job.itemId) {
    const q = await prisma.storyItem.findUnique({ where: { id: job.itemId }, select: { checked: true } })
    return end(job, "done", q?.checked ? "answered" : "left open for the next session", log)
  }
  if (job.kind === "story-phases") {
    const n = await prisma.storyPhase.count({ where: { storyId: job.storyId } })
    if (!n) return end(job, "failed", "The session ended without adding any phases.", log)
    await end(job, "done", `${n} phase${n === 1 ? "" : "s"}`, log)
    await prisma.story.updateMany({ where: { id: job.storyId, status: "planning" }, data: { status: "phases-ready" } })
    return
  }
  if (job.kind === "phase-checklist" && job.phaseId) {
    const n = await prisma.storyItem.count({ where: { phaseId: job.phaseId, answer: null } })
    return end(job, "done", n ? `${n} checklist item${n === 1 ? "" : "s"}` : "nothing to add", log)
  }
  if (job.kind === "phase-steps" && job.phaseId) {
    const n = await prisma.storyStep.count({ where: { phaseId: job.phaseId } })
    if (!n) return end(job, "failed", "The session ended without adding any steps.", log)
    await end(job, "done", `${n} step${n === 1 ? "" : "s"}`, log)
    await prisma.storyPhase.updateMany({ where: { id: job.phaseId, status: "planning" }, data: { status: "steps-ready" } })
    return
  }
  if (job.kind === "step" && job.stepId) {
    const st = await prisma.storyStep.findUnique({ where: { id: job.stepId }, select: { status: true } })
    if (st?.status === "done" || st?.status === "verifying") {
      const note = await finishStep(job.stepId, log)
      return end(job, "done", job.note ? `${job.note.slice(0, 1500)} · ${note}` : note, log)
    }
    if (st?.status === "blocked") { await end(job, "done", job.note || "blocked", log); await block(job.storyId); return }
    return end(job, "done", NOFINISH, log)
  }
  return end(job, "done", "", log)
}

/** Whether the story (and phase) are still where this job's kind runs. */
function stillWanted(job: Job): string | null {
  const st = job.story.status
  if (job.kind.startsWith("story-")) return st === "planning" ? null : `The story is ${st}.`
  if (st !== "in-progress") return `The story is ${st}.`
  if (job.kind.startsWith("phase-") && job.phase?.status !== "planning") return `Phase ${job.phase?.number} is ${job.phase?.status ?? "gone"}.`
  if (job.kind === "step" && job.phase?.status !== "in-progress") return `Phase ${job.phase?.number} is ${job.phase?.status ?? "gone"}.`
  return null
}

export async function checkJob(job: Job, log: Log, now = Date.now()) {
  const dir = workspacePath(job.story.project.slug)
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
    log(`story ${job.story.number}: the session put a question; refused (planning sessions record questions as checklist items)`)
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
  const stories = await prisma.story.findMany({ where: { status: { in: ["planning", "in-progress"] }, ...(projectId ? { projectId } : {}) }, orderBy: { createdAt: "asc" }, select: { id: true } })
  for (const { id } of stories) {
    const s = await getStory(id)
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

/** Stops the story's running session (if any); the job is marked stopped. */
export async function stopStoryJobs(storyId: string, why: string) {
  const jobs = await prisma.storyJob.findMany({ where: { storyId, state: "running" }, include: { story: { include: { project: true } } } })
  for (const j of jobs) {
    await ocAbort(workspacePath(j.story.project.slug), j.sessionId)
    await prisma.storyJob.update({ where: { id: j.id }, data: { state: "stopped", note: why, endedAt: new Date() } })
  }
}

type R = { ok: true } | { ok: false; message: string }
async function move(storyId: string, from: string[], to: string, data: { resumeTo?: string | null } = {}): Promise<R> {
  const r = await prisma.story.updateMany({ where: { id: storyId, status: { in: from } }, data: { status: to, ...data } })
  return r.count ? { ok: true } : { ok: false, message: "The story has moved on; the page shows its state now." }
}
const DIRECTION_MAX = 4000

export async function pauseStory(storyId: string): Promise<R> {
  const st = await prisma.story.findUnique({ where: { id: storyId }, select: { status: true } })
  if (!st || (st.status !== "planning" && st.status !== "in-progress")) return { ok: false, message: "Only a story that MAW is working on can be paused." }
  const r = await move(storyId, [st.status], "paused", { resumeTo: st.status })
  if (r.ok) await stopStoryJobs(storyId, "Paused by you.")
  return r
}
/** Resume (paused) or Retry (blocked): the story goes back to where it was. */
export async function resumeStory(storyId: string): Promise<R> {
  const st = await prisma.story.findUnique({ where: { id: storyId }, select: { status: true, resumeTo: true } })
  if (!st || (st.status !== "paused" && st.status !== "blocked")) return { ok: false, message: "The story has moved on; the page shows its state now." }
  return move(storyId, [st.status], st.resumeTo === "in-progress" ? "in-progress" : "planning", { resumeTo: null })
}
export const approvePhases = (storyId: string) => move(storyId, ["phases-ready"], "in-progress")

/** Adds your direction as an answered item on the story (phaseId null) or phase checklist. */
async function addDirection(storyId: string, phaseId: string | null, text: string, d: string) {
  const last = await prisma.storyItem.findFirst({ where: { storyId, phaseId }, orderBy: { position: "desc" }, select: { position: true } })
  await prisma.storyItem.create({
    data: { storyId, phaseId, position: (last?.position ?? 0) + 1, text, developer: true, answer: d, checked: true, checkedAt: new Date() },
  })
}

/** Plans the phases again; your direction (optional) is kept as an answered item the next plan reads. */
export async function replanPhases(storyId: string, direction: string): Promise<R> {
  const d = direction.trim()
  if (d.length > DIRECTION_MAX) return { ok: false, message: "Keep the direction under 4,000 characters." }
  const r = await move(storyId, ["phases-ready"], "planning")
  if (r.ok && d) await addDirection(storyId, null, "Your direction for the phases", d)
  return r
}

/** The story's current phase, checked against what the button expects. */
async function phaseFor(phaseId: string, status: string) {
  const ph = await prisma.storyPhase.findUnique({ where: { id: phaseId }, include: { story: { include: { phases: { orderBy: { number: "asc" } } } } } })
  if (!ph) return { ok: false as const, message: "This phase no longer exists." }
  if (ph.story.status !== "in-progress") return { ok: false as const, message: `The story is ${ph.story.status}; the phases are approved and worked only while it is in progress.` }
  const cur = currentPhase(ph.story)
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
  const r = await prisma.storyPhase.updateMany({ where: { id: phaseId, status: "pending" }, data: { status: "planning" } })
  if (!r.count) return { ok: false, message: "The phase has moved on; the page shows its state now." }
  if (d) await addDirection(f.ph.storyId, phaseId, `Your direction for phase ${f.ph.number}'s steps`, d)
  return { ok: true }
}

/** The steps are approved: the phase is in progress (its steps are carried out next). */
export async function approveSteps(phaseId: string): Promise<R> {
  const f = await phaseFor(phaseId, "steps-ready")
  if (!f.ok) return f
  const r = await prisma.storyPhase.updateMany({ where: { id: phaseId, status: "steps-ready" }, data: { status: "in-progress" } })
  return r.count ? { ok: true } : { ok: false, message: "The phase has moved on; the page shows its state now." }
}

/** Plans the phase's steps again (its checklist is kept); your direction (optional) is read by the next plan. */
export async function replanSteps(phaseId: string, direction: string): Promise<R> {
  const d = direction.trim()
  if (d.length > DIRECTION_MAX) return { ok: false, message: "Keep the direction under 4,000 characters." }
  const f = await phaseFor(phaseId, "steps-ready")
  if (!f.ok) return f
  const r = await prisma.storyPhase.updateMany({ where: { id: phaseId, status: "steps-ready" }, data: { status: "planning" } })
  if (!r.count) return { ok: false, message: "The phase has moved on; the page shows its state now." }
  if (d) await addDirection(f.ph.storyId, phaseId, `Your direction for phase ${f.ph.number}'s steps`, d)
  return { ok: true }
}

/** The step, checked to be the current phase's current step in a story MAW is working on. */
async function stepFor(stepId: string, statuses: string[]) {
  const st = await prisma.storyStep.findUnique({ where: { id: stepId }, include: { phase: { include: { story: { include: { phases: { orderBy: { number: "asc" } } } } } } } })
  if (!st) return { ok: false as const, message: "This step no longer exists." }
  const story = st.phase.story
  if (story.status !== "in-progress" && story.status !== "blocked") return { ok: false as const, message: `The story is ${story.status}.` }
  if (currentPhase(story)?.id !== st.phaseId || st.phase.status !== "in-progress") return { ok: false as const, message: "This step's phase is not the one being worked on." }
  if (!statuses.includes(st.status)) return { ok: false as const, message: "The step has moved on; the page shows its state now." }
  return { ok: true as const, st, story }
}
async function unblock(storyId: string) {
  await prisma.story.updateMany({ where: { id: storyId, status: "blocked" }, data: { status: "in-progress", resumeTo: null } })
}

/** Your manual check of a step marked Check: right → done; not right → the step runs again with your note. */
export async function checkStep(stepId: string, right: boolean, note: string): Promise<R> {
  const n = note.trim()
  if (!right && !n) return { ok: false, message: "Say what is not right; the next session reads it." }
  if (n.length > DIRECTION_MAX) return { ok: false, message: "Keep the note under 4,000 characters." }
  const f = await stepFor(stepId, ["waiting-check"])
  if (!f.ok) return f
  await prisma.storyStep.update({
    where: { id: stepId },
    data: right ? { status: "done", result: addLine(f.st.result, `Developer checked it${n ? `: ${n}` : "."}`) } : { status: "pending", result: addLine(f.st.result, `Developer: not right: ${n}`) },
  })
  return { ok: true }
}

/** A blocked step runs again (your direction, optional, is read by the next session). */
export async function retryStep(stepId: string, direction: string): Promise<R> {
  const d = direction.trim()
  if (d.length > DIRECTION_MAX) return { ok: false, message: "Keep the direction under 4,000 characters." }
  const f = await stepFor(stepId, ["blocked"])
  if (!f.ok) return f
  await prisma.storyJob.updateMany({ where: { stepId, note: NOFINISH }, data: { note: `${NOFINISH} (before your retry)` } })
  await prisma.storyStep.update({ where: { id: stepId }, data: { status: "pending", result: d ? addLine(f.st.result, `Developer: ${d}`) : f.st.result } })
  await unblock(f.story.id)
  return { ok: true }
}

/** You did (or checked) the step yourself: it is done, and the story goes on. */
export async function markStepDone(stepId: string): Promise<R> {
  const f = await stepFor(stepId, ["blocked", "waiting-check"])
  if (!f.ok) return f
  await prisma.storyStep.update({ where: { id: stepId }, data: { status: "done", result: addLine(f.st.result, "Developer marked it done.") } })
  await unblock(f.story.id)
  return { ok: true }
}
