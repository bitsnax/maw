import { mkdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { prisma } from "./prisma"
import { getStory, type FullStory } from "./stories"
import { startSession } from "./sessions"
import { workspacePath } from "./workspace"
import { WORKSPACES } from "./tools"
import { ocAbort, ocMessages, ocPrompt, ocQuestionReject, ocQuestions, ocStatus } from "./opencode"
import { checklistPrompt, itemPrompt, phasesPrompt } from "./story-prompts"
import type { JobKind } from "./story-tools"

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
// A session that fails (model error, no answer, nothing recorded) sets the
// story to "blocked" with the reason on its job; Retry on the Dashboard
// sets it back to "planning".

export const ITEM_SESSIONS = 3
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
  | { kind: "start"; job: JobKind; itemId?: string; position?: number }
  | { kind: "wait"; why: string }

const runningJob = (projectId?: string) => prisma.storyJob.findFirst({
  where: { state: "running", ...(projectId ? { story: { projectId } } : {}) }, orderBy: { createdAt: "asc" },
  include: { story: { include: { project: true } }, item: { select: { position: true } } },
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
  const jobs = await prisma.storyJob.findMany({ where: { storyId: s.id }, select: { kind: true, state: true, itemId: true } })
  if (!jobs.some((j) => j.kind === "story-checklist" && j.state === "done")) return { kind: "start", job: "story-checklist" }
  for (const q of s.items) {
    if (q.checked || q.developer) continue
    const tried = jobs.filter((j) => j.itemId === q.id && j.state === "done").length
    if (tried < ITEM_SESSIONS) return { kind: "start", job: "story-item", itemId: q.id, position: q.position }
    // Still open after ITEM_SESSIONS sessions: the developer answers it.
    await prisma.storyItem.update({ where: { id: q.id }, data: { developer: true } })
    await prisma.storyFinding.create({
      data: {
        storyId: s.id, itemId: q.id, position: await nextFinding(s.id), heading: "Handed to you",
        body: `The agent left this item open after ${ITEM_SESSIONS} sessions. Answer it from what is known (see the findings), and planning goes on.`,
      },
    })
  }
  const open = await prisma.storyItem.count({ where: { storyId: s.id, phaseId: null, checked: false } })
  if (open) return { kind: "wait", why: `${open} checklist item${open === 1 ? "" : "s"} for you` }
  return { kind: "start", job: "story-phases" }
}

async function nextFinding(storyId: string) {
  const last = await prisma.storyFinding.findFirst({ where: { storyId }, orderBy: { position: "desc" }, select: { position: true } })
  return (last?.position ?? 0) + 1
}

// ---- starting a job -----------------------------------------------------------------

/** Clears what an earlier, unfinished attempt at the same pass left behind. */
async function prepare(s: FullStory, kind: JobKind) {
  if (kind === "story-checklist") {
    await prisma.storyFinding.deleteMany({ where: { storyId: s.id, phaseId: null } })
    await prisma.storyItem.deleteMany({ where: { storyId: s.id, phaseId: null } })
  }
  if (kind === "story-phases") {
    await prisma.storyPhase.deleteMany({ where: { storyId: s.id } })
    await prisma.story.update({ where: { id: s.id }, data: { overview: "", outOfScope: "", notes: "" } })
  }
}

function jobTitle(s: FullStory, a: Extract<Action, { kind: "start" }>): string {
  if (a.job === "story-checklist") return `Story ${s.number} · checklist`
  if (a.job === "story-item") return `Story ${s.number} · item ${a.position}`
  return `Story ${s.number} · phases`
}

async function fail(storyId: string, kind: string, note: string, sessionId?: string, itemId?: string) {
  if (sessionId) {
    await prisma.storyJob.update({ where: { sessionId }, data: { state: "failed", note: note.slice(0, 2000), endedAt: new Date() } })
  } else {
    // No session could be started: a job row records why, with a stand-in id.
    await prisma.storyJob.create({
      data: { storyId, kind, itemId, sessionId: `none-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, state: "failed", note: note.slice(0, 2000), endedAt: new Date() },
    })
  }
  await prisma.story.updateMany({ where: { id: storyId }, data: { status: "blocked" } })
}

export async function startJob(s: FullStory, a: Extract<Action, { kind: "start" }>, log: Log) {
  await prepare(s, a.job)
  const fresh = (await getStory(s.id))!
  const item = a.itemId ? fresh.items.find((q) => q.id === a.itemId) : undefined
  const prompt = a.job === "story-checklist" ? checklistPrompt(fresh) : a.job === "story-item" && item ? itemPrompt(fresh, item) : phasesPrompt(fresh)
  const title = jobTitle(fresh, a)
  const ss = await startSession(s.projectId, null, title)
  if (!ss.ok) { log(`story ${s.number}: ${title}: no session: ${ss.message}`); await fail(s.id, a.job, `The session could not be started: ${ss.message}`, undefined, a.itemId); return }
  await prisma.storyJob.create({ data: { storyId: s.id, kind: a.job, itemId: a.itemId ?? null, sessionId: ss.session.id } })
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
  log(`story ${job.story.number}: ${JOB_LABEL[job.kind] ?? job.kind}${job.item ? ` ${job.item.position}` : ""} ${state}${note ? `: ${note}` : ""}`)
  if (state === "failed") { await fail(job.storyId, job.kind, note, job.sessionId); return }
  await prisma.storyJob.update({ where: { id: job.id }, data: { state, note: (job.note || note).slice(0, 2000), endedAt: new Date() } })
}

/** What a finished session left, checked against what its kind must leave. */
async function settle(job: Job, log: Log) {
  if (job.kind === "story-checklist") {
    const n = await prisma.storyItem.count({ where: { storyId: job.storyId, phaseId: null } })
    if (!n) return end(job, "failed", "The session ended without adding any checklist items.", log)
    return end(job, "done", `${n} checklist item${n === 1 ? "" : "s"}`, log)
  }
  if (job.kind === "story-item" && job.itemId) {
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
  return end(job, "done", "", log)
}

export async function checkJob(job: Job, log: Log, now = Date.now()) {
  const dir = workspacePath(job.story.project.slug)
  const age = now - job.createdAt.getTime()
  if (job.story.status !== "planning") {
    await ocAbort(dir, job.sessionId)
    return end(job, "stopped", `The story is ${job.story.status}.`, log)
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
  const stories = await prisma.story.findMany({ where: { status: "planning", ...(projectId ? { projectId } : {}) }, orderBy: { createdAt: "asc" }, select: { id: true } })
  for (const { id } of stories) {
    const s = await getStory(id)
    if (!s || s.status !== "planning") continue
    const a = await planningAction(s)
    if (a.kind === "wait") continue
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
async function move(storyId: string, from: string[], to: string): Promise<R> {
  const r = await prisma.story.updateMany({ where: { id: storyId, status: { in: from } }, data: { status: to } })
  return r.count ? { ok: true } : { ok: false, message: "The story has moved on; the page shows its state now." }
}

export async function pauseStory(storyId: string): Promise<R> {
  const r = await move(storyId, ["planning"], "paused")
  if (r.ok) await stopStoryJobs(storyId, "Paused by you.")
  return r
}
/** Resume (paused) or Retry (blocked): planning goes on from where it stopped. */
export const resumeStory = (storyId: string) => move(storyId, ["paused", "blocked"], "planning")
export const approvePhases = (storyId: string) => move(storyId, ["phases-ready"], "in-progress")

/** Plans the phases again; your direction (optional) is kept as an answered item the next plan reads. */
export async function replanPhases(storyId: string, direction: string): Promise<R> {
  const d = direction.trim()
  if (d.length > 4000) return { ok: false, message: "Keep the direction under 4,000 characters." }
  const r = await move(storyId, ["phases-ready"], "planning")
  if (!r.ok || !d) return r
  const last = await prisma.storyItem.findFirst({ where: { storyId, phaseId: null }, orderBy: { position: "desc" }, select: { position: true } })
  await prisma.storyItem.create({
    data: { storyId, phaseId: null, position: (last?.position ?? 0) + 1, text: "Your direction for the phases", developer: true, answer: d, checked: true, checkedAt: new Date() },
  })
  return r
}
