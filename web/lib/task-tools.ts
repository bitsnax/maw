import { prisma } from "./prisma"
import { PHASE_STATUS, STEP_STATUS, getTask, type FullTask } from "./tasks"

// The task tools: what a model session MAW runs for a task uses to record
// its work in MAW's database (checklists, findings, the task plan, phases,
// steps, step results) and to read back what earlier sessions recorded.
// OpenCode calls them through MAW's tool API (lib/tools.ts) like the six
// file tools; the session id finds the job, and the job's kind decides which
// tools it may use and what they work on.
//
//   kind              may use (besides task_read)
//   task-checklist   item_add                       (task checklist)
//   task-item        finding_add, item_check, item_add
//   task-phases      task_plan_set, phase_add
//   phase-checklist   item_add                       (the phase's checklist)
//   phase-item        finding_add, item_check, item_add
//   phase-steps       phase_plan_set, step_add
//   step              step_note, step_finish

export const TASK_TOOL_NAMES = [
  "task_read", "item_add", "item_check", "finding_add", "task_plan_set", "phase_add", "phase_plan_set", "step_add", "step_note", "step_finish",
] as const
export type TaskToolName = (typeof TASK_TOOL_NAMES)[number]
export const JOB_KINDS = ["task-checklist", "task-item", "task-phases", "phase-checklist", "phase-item", "phase-steps", "step"] as const
export type JobKind = (typeof JOB_KINDS)[number]

const ALLOWED: Record<JobKind, TaskToolName[]> = {
  "task-checklist": ["item_add"],
  "task-item": ["finding_add", "item_check", "item_add"],
  "task-phases": ["task_plan_set", "phase_add"],
  "phase-checklist": ["item_add"],
  "phase-item": ["finding_add", "item_check", "item_add"],
  "phase-steps": ["phase_plan_set", "step_add"],
  step: ["step_note", "step_finish"],
}
const KIND_TEXT: Record<JobKind, string> = {
  "task-checklist": "writing the task's checklist", "task-item": "answering a task checklist item",
  "task-phases": "writing the task plan and its phases", "phase-checklist": "writing a phase's checklist",
  "phase-item": "answering a phase checklist item", "phase-steps": "writing a phase's steps", step: "carrying out one step",
}

export class TaskToolError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

type Args = Record<string, unknown>
const LIMIT = 20000

function text(a: Args, k: string, required: boolean, max = LIMIT): string | undefined {
  const v = a[k]
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (required) throw new TaskToolError(400, `${k} is required.`)
    return undefined
  }
  if (typeof v !== "string") throw new TaskToolError(400, `${k} must be text.`)
  if (v.length > max) throw new TaskToolError(400, `${k} is over ${max} characters; keep it shorter.`)
  return v.trim()
}
function bool(a: Args, k: string): boolean | undefined {
  const v = a[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "boolean") throw new TaskToolError(400, `${k} must be true or false.`)
  return v
}
function pos(a: Args, k: string): number | undefined {
  const v = a[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new TaskToolError(400, `${k} must be a whole number from 1.`)
  return v
}

/** The job of a session, or null when the session is not a task session. */
export function jobOf(sessionId: string) {
  return sessionId ? prisma.taskJob.findUnique({ where: { sessionId } }) : Promise.resolve(null)
}
type Job = NonNullable<Awaited<ReturnType<typeof jobOf>>>

async function nextItem(taskId: string, phaseId: string | null) {
  const last = await prisma.taskItem.findFirst({ where: { taskId, phaseId }, orderBy: { position: "desc" }, select: { position: true } })
  return (last?.position ?? 0) + 1
}
async function nextFinding(taskId: string) {
  const last = await prisma.taskFinding.findFirst({ where: { taskId }, orderBy: { position: "desc" }, select: { position: true } })
  return (last?.position ?? 0) + 1
}
/** The item a call names (position in the job's checklist) or the job's own item. */
async function targetItem(job: Job, position: number | undefined) {
  const phaseId = job.kind.startsWith("phase") ? job.phaseId : null
  if (position !== undefined) {
    const it = await prisma.taskItem.findFirst({ where: { taskId: job.taskId, phaseId, position } })
    if (!it) throw new TaskToolError(404, `There is no checklist item ${position} here.`)
    return it
  }
  if (!job.itemId) throw new TaskToolError(400, "Name the checklist item (item: its number).")
  return prisma.taskItem.findUniqueOrThrow({ where: { id: job.itemId } })
}

// ---- task_read: what earlier sessions recorded, as markdown -------------------

function checklistMd(items: FullTask["items"]): string {
  if (!items.length) return "(no checklist yet)"
  return items.map((q) => {
    const head = `${q.position}. [${q.checked ? "x" : " "}] ${q.developer ? "(for the developer) " : ""}${q.text}${q.answer ? `\n   Developer's answer: ${q.answer}` : ""}`
    const fs = q.findings.map((f) => `   ### ${f.heading || "Finding"}\n${f.body.replace(/^/gm, "   ")}`)
    return [head, ...fs].join("\n")
  }).join("\n")
}
export function stepMd(p: FullTask["phases"][number], x: FullTask["phases"][number]["steps"][number]): string {
  const sec = (h: string, t: string) => (t.trim() ? `## ${h}\n${t.trim()}\n` : "")
  return [`# Step ${p.number}.${x.number}: ${x.title}`, `Status: ${STEP_STATUS[x.status] ?? x.status}${x.check ? " · needs a developer check" : ""}`,
    x.files ? `Files: ${x.files}` : "", sec("Goal", x.goal), sec("Read budget", x.readBudget), sec("Context", x.context), sec("Changes", x.changes),
    sec("Verification", x.verification), sec("Manual check", x.manualCheck), sec("Result so far", x.result)].filter(Boolean).join("\n")
}

export function taskReadMd(s: FullTask, part: string, number?: string): string {
  if (part === "task") {
    return [`# Task: ${s.title}`, `## Request\n${s.request}`,
      s.overview && `## Overview\n${s.overview}`, s.outOfScope && `## Out of scope\n${s.outOfScope}`, s.notes && `## Notes\n${s.notes}`,
      `## Task checklist\n${checklistMd(s.items)}`,
      s.findings.length ? `## Other findings\n${s.findings.map((f) => `### ${f.heading || "Finding"}\n${f.body}`).join("\n")}` : "",
      `## Phases\n${s.phases.length ? s.phases.map((p) => `${p.number}. ${p.title} — ${PHASE_STATUS[p.status] ?? p.status}${p.steps.length ? ` (${p.steps.length} steps)` : ""}`).join("\n") : "(none yet)"}`,
    ].filter(Boolean).join("\n\n")
  }
  if (part === "phase") {
    const p = s.phases.find((x) => String(x.number) === (number ?? "").trim())
    if (!p) throw new TaskToolError(404, `There is no phase ${number ?? ""}. Phases: ${s.phases.map((x) => x.number).join(", ") || "none"}.`)
    return [`# Phase ${p.number}: ${p.title}`, `Status: ${PHASE_STATUS[p.status] ?? p.status}`,
      p.goal && `## Goal\n${p.goal}`, p.approach && `## Approach\n${p.approach}`, p.notes && `## Notes\n${p.notes}`,
      `## Phase checklist\n${checklistMd(p.items as FullTask["items"])}`,
      p.findings.length ? `## Other findings\n${p.findings.map((f) => `### ${f.heading || "Finding"}\n${f.body}`).join("\n")}` : "",
      `## Steps\n${p.steps.length ? p.steps.map((x) => `${p.number}.${x.number} ${x.title} — ${STEP_STATUS[x.status] ?? x.status}`).join("\n") : "(none yet)"}`,
    ].filter(Boolean).join("\n\n")
  }
  if (part === "step") {
    const m = /^(\d+)\.(\d+)$/.exec((number ?? "").trim())
    const p = m ? s.phases.find((x) => x.number === Number(m[1])) : undefined
    const x = p?.steps.find((y) => y.number === Number(m![2]))
    if (!p || !x) throw new TaskToolError(404, `There is no step ${number ?? ""} (write it as phase.step, for example 2.3).`)
    return stepMd(p, x)
  }
  throw new TaskToolError(400, `part must be task, phase or step.`)
}

// ---- the tools ----------------------------------------------------------------------

export async function handleTaskTool(name: TaskToolName, sessionId: string, a: Args): Promise<{ title: string; output: string }> {
  const job = await jobOf(sessionId)
  if (!job) throw new TaskToolError(403, `${name} is for sessions MAW runs for a task; this session is not one.`)
  if (job.state !== "running") throw new TaskToolError(409, `This task session has ended (${job.state}); ${name} is no longer accepted.`)
  const kind = job.kind as JobKind
  if (name !== "task_read" && !ALLOWED[kind]?.includes(name)) {
    throw new TaskToolError(403, `${name} is not for this session: it is ${KIND_TEXT[kind] ?? kind}, which uses ${["task_read", ...(ALLOWED[kind] ?? [])].join(", ")}.`)
  }
  const touch = () => prisma.task.update({ where: { id: job.taskId }, data: { updatedAt: new Date() } })

  switch (name) {
    case "task_read": {
      const s = await getTask(job.taskId)
      if (!s) throw new TaskToolError(404, "The task no longer exists.")
      const part = text(a, "part", true, 20)!
      const out = taskReadMd(s, part, text(a, "number", false, 20))
      return { title: `task ${part}${a.number ? ` ${String(a.number)}` : ""}`, output: out }
    }
    case "item_add": {
      const phaseId = kind.startsWith("phase") ? job.phaseId : null
      const t = text(a, "text", true, 2000)!
      const position = await nextItem(job.taskId, phaseId)
      await prisma.taskItem.create({ data: { taskId: job.taskId, phaseId, position, text: t, developer: bool(a, "forDeveloper") ?? false } })
      await touch()
      return { title: `item ${position}`, output: `Added checklist item ${position}${bool(a, "forDeveloper") ? " (for the developer to answer)" : ""}.` }
    }
    case "finding_add": {
      const it = await targetItem(job, pos(a, "item"))
      const body = text(a, "body", true)!
      await prisma.taskFinding.create({
        data: { taskId: job.taskId, phaseId: it.phaseId, itemId: it.id, position: await nextFinding(job.taskId), heading: text(a, "heading", false, 200) ?? "", body },
      })
      await touch()
      return { title: `finding for item ${it.position}`, output: `Recorded the finding under item ${it.position}.` }
    }
    case "item_check": {
      const it = await targetItem(job, pos(a, "item"))
      const answered = bool(a, "answered") ?? true
      const note = text(a, "note", false, 4000)
      if (note) {
        await prisma.taskFinding.create({
          data: { taskId: job.taskId, phaseId: it.phaseId, itemId: it.id, position: await nextFinding(job.taskId), heading: answered ? "Answer" : "Still open", body: note },
        })
      }
      if (answered) await prisma.taskItem.update({ where: { id: it.id }, data: { checked: true, checkedAt: new Date() } })
      await touch()
      return { title: `item ${it.position}`, output: answered ? `Item ${it.position} is checked.` : `Item ${it.position} stays open${note ? "; your note is recorded for the next session" : ""}.` }
    }
    case "task_plan_set": {
      const data = { overview: text(a, "overview", false), outOfScope: text(a, "outOfScope", false), notes: text(a, "notes", false) }
      if (!data.overview && !data.outOfScope && !data.notes) throw new TaskToolError(400, "Give at least one of overview, outOfScope, notes.")
      await prisma.task.update({ where: { id: job.taskId }, data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) })
      return { title: "task plan", output: `Saved ${Object.entries(data).filter(([, v]) => v !== undefined).map(([k]) => k).join(", ")}.` }
    }
    case "phase_add": {
      const title = text(a, "title", true, 200)!
      const last = await prisma.taskPhase.findFirst({ where: { taskId: job.taskId }, orderBy: { number: "desc" }, select: { number: true } })
      const number = (last?.number ?? 0) + 1
      await prisma.taskPhase.create({
        data: { taskId: job.taskId, number, title, goal: text(a, "goal", true)!, approach: text(a, "approach", false) ?? "", notes: text(a, "notes", false) ?? "" },
      })
      await touch()
      return { title: `phase ${number}`, output: `Added phase ${number}: ${title}.` }
    }
    case "phase_plan_set": {
      if (!job.phaseId) throw new TaskToolError(400, "This session has no phase.")
      const data = { goal: text(a, "goal", false), approach: text(a, "approach", false), notes: text(a, "notes", false) }
      if (!data.goal && !data.approach && !data.notes) throw new TaskToolError(400, "Give at least one of goal, approach, notes.")
      await prisma.taskPhase.update({ where: { id: job.phaseId }, data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) })
      await touch()
      return { title: "phase plan", output: `Saved ${Object.entries(data).filter(([, v]) => v !== undefined).map(([k]) => k).join(", ")}.` }
    }
    case "step_add": {
      if (!job.phaseId) throw new TaskToolError(400, "This session has no phase.")
      const ph = await prisma.taskPhase.findUniqueOrThrow({ where: { id: job.phaseId } })
      const title = text(a, "title", true, 200)!
      const last = await prisma.taskStep.findFirst({ where: { phaseId: ph.id }, orderBy: { number: "desc" }, select: { number: true } })
      const number = (last?.number ?? 0) + 1
      await prisma.taskStep.create({
        data: {
          phaseId: ph.id, number, title, files: text(a, "files", false, 1000) ?? "", check: bool(a, "needsCheck") ?? false, deploy: bool(a, "needsDeploy") ?? false,
          goal: text(a, "goal", true)!, readBudget: text(a, "readBudget", false) ?? "", context: text(a, "context", false) ?? "",
          changes: text(a, "changes", true)!, verification: text(a, "verification", false) ?? "", manualCheck: text(a, "manualCheck", false) ?? "",
        },
      })
      await touch()
      return { title: `step ${ph.number}.${number}`, output: `Added step ${ph.number}.${number}: ${title}.` }
    }
    case "step_note": {
      if (!job.stepId) throw new TaskToolError(400, "This session has no step.")
      const t = text(a, "text", true, 4000)!
      const st = await prisma.taskStep.findUniqueOrThrow({ where: { id: job.stepId } })
      await prisma.taskStep.update({ where: { id: st.id }, data: { result: `${st.result}${st.result && !st.result.endsWith("\n") ? "\n" : ""}- ${t}\n`, status: st.status === "pending" ? "in-progress" : st.status } })
      await touch()
      return { title: "step note", output: "Noted." }
    }
    case "step_finish": {
      if (!job.stepId) throw new TaskToolError(400, "This session has no step.")
      const status = text(a, "status", true, 20)!
      if (status !== "done" && status !== "blocked") throw new TaskToolError(400, "status must be done or blocked.")
      const summary = text(a, "summary", true, 4000)!
      const st = await prisma.taskStep.findUniqueOrThrow({ where: { id: job.stepId } })
      await prisma.taskStep.update({
        where: { id: st.id },
        // done → verifying: the step is Done only once MAW's verify commands pass.
        data: { status: status === "done" ? "verifying" : "blocked", result: `${st.result}${st.result && !st.result.endsWith("\n") ? "\n" : ""}${status === "done" ? "Done" : "Blocked"}: ${summary}\n` },
      })
      await prisma.taskJob.update({ where: { id: job.id }, data: { note: `${status}: ${summary}`.slice(0, 2000) } })
      await touch()
      return { title: `step ${status}`, output: status === "done" ? "Recorded as done. MAW runs the verify commands next; stop here." : "Recorded as blocked. Stop here; the developer will look at it." }
    }
  }
}

// ---- bash in task sessions: no state-changing git ------------------------------------

const GIT_WRITE = new Set([
  "add", "am", "apply", "branch", "checkout", "cherry-pick", "clean", "clone", "commit", "config", "fetch", "filter-branch", "gc", "init",
  "merge", "mv", "notes", "prune", "pull", "push", "rebase", "remote", "replace", "reset", "restore", "revert", "rm", "stash", "submodule",
  "switch", "tag", "update-index", "update-ref", "worktree",
])

/** The state-changing git subcommands in a command line (empty if none). */
export function gitWrites(command: string): string[] {
  const out: string[] = []
  const re = /(?:^|[\s;&|(`$])git((?:\s+(?:-C|-c|--git-dir|--work-tree|--namespace)\s+\S+|\s+--?[\w-]+(?:=\S+)?)*)\s+([a-z][\w-]*)/g
  for (const m of command.matchAll(re)) if (GIT_WRITE.has(m[2]!)) out.push(m[2]!)
  return [...new Set(out)]
}

/** docker / docker compose commands that change what runs (deploys are MAW's in task sessions). */
export function dockerWrites(command: string): string[] {
  const out: string[] = []
  const re = /(?:^|[\s;&|(`$])(docker(?:-compose|\s+compose)?)((?:\s+--?[\w-]+(?:[=\s]\S+)?)*)\s+(up|down|restart|stop|start|build|rm|kill|run|exec|create|pull|push)\b/g
  for (const m of command.matchAll(re)) out.push(`${m[1]!.replace(/\s+/g, " ")} ${m[3]}`)
  return [...new Set(out)]
}
