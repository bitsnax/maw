/**
 * Self-test for tasks (lib/tasks): Task ─ Phase ─ Step with checklists
 * and findings at task and phase level, numbering, checks, edit, the view
 * MAW builds (getTask), progress, the markdown download, the project
 * profile, and removal with everything under it.
 *
 *   docker compose run --rm --no-deps migrate \
 *     npx tsx scripts/tasks-selftest.ts check <machine id> <root>
 *
 * Uses a temporary project (selftest-task-*), removed at the end. Nothing
 * is written into the folder: tasks live only in MAW's database.
 */

import { prisma } from "../lib/prisma"
import { createProject, removeProject } from "../lib/projects"
import { gitWrites, handleTaskTool } from "../lib/task-tools"
import {
  checkTaskInput, createTask, getTask, listTasks, progress, removeTask, saveProfile, taskKey, taskMarkdown, updateTask,
} from "../lib/tasks"

let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  const d = detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}`
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : d}`)
  if (!ok) failed++
}

async function run(machineId: string, root: string) {
  console.log("checks")
  const e = checkTaskInput({ title: " ", request: "", branch: "bad branch.." })
  check("empty title and request, bad branch refused", !!e.title && !!e.request && !!e.branch, e)
  check("a normal branch is fine", !checkTaskInput({ title: "x", request: "y", branch: "task/tool-count" }).branch)
  check("task key", taskKey({ number: 3, title: "Tool count per Connection!" }) === "3-tool-count-per-connection")

  const tag = `selftest-task-${Date.now() % 100000}`
  const p = await createProject({ name: tag, machineId, root }, null)
  if (!p.ok) { check("project for the test", false, p); return }
  try {
    console.log("tasks")
    const a = await createTask(p.project.id, null, { title: "Tool count per connection", request: "Show how many tools use each connection.", branch: "" })
    const b = await createTask(p.project.id, null, { title: "Second", request: "Another." })
    check("created and numbered 1, 2; status Planning phases; no branch", a.ok && b.ok && a.task.number === 1 && b.task.number === 2 && a.task.status === "planning" && a.task.branch === null)
    if (!a.ok || !b.ok) return
    const u = await updateTask(a.task.id, { title: "Tool count", request: "Show the count.", branch: "task-1-tool-count" })
    const a2 = await prisma.task.findUniqueOrThrow({ where: { id: a.task.id } })
    check("edited: title, request, branch", u.ok && a2.title === "Tool count" && a2.branch === "task-1-tool-count")
    check("listed newest first", (await listTasks(p.project.id)).map((s) => s.number).join() === "2,1")

    console.log("phases, steps, checklists (as the agent's tools will write them)")
    const s = a.task.id
    const q1 = await prisma.taskItem.create({ data: { taskId: s, position: 1, text: "Where is the connections page?", checked: true } })
    await prisma.taskItem.create({ data: { taskId: s, position: 2, text: "Count drafts too?", developer: true } })
    await prisma.taskFinding.create({ data: { taskId: s, itemId: q1.id, position: 1, heading: "Connections page", body: "`web/src/app/settings/connections/page.tsx`" } })
    const ph1 = await prisma.taskPhase.create({ data: { taskId: s, number: 1, title: "Count", goal: "A count function.", status: "in-progress" } })
    const ph2 = await prisma.taskPhase.create({ data: { taskId: s, number: 2, title: "Show it", status: "pending" } })
    const pq = await prisma.taskItem.create({ data: { taskId: s, phaseId: ph1.id, position: 1, text: "How are bindings shaped?", checked: true } })
    await prisma.taskFinding.create({ data: { taskId: s, phaseId: ph1.id, itemId: pq.id, position: 1, heading: "Bindings", body: "kind http | sql" } })
    await prisma.taskStep.create({ data: { phaseId: ph1.id, number: 1, title: "Count function", status: "done", result: "added" } })
    await prisma.taskStep.create({ data: { phaseId: ph1.id, number: 2, title: "Tests", check: true } })
    await prisma.taskStep.create({ data: { phaseId: ph2.id, number: 1, title: "Show it" } })
    const g = (await getTask(s))!
    check("task checklist: 2 items, one finding under the first", g.items.length === 2 && g.items[0]!.findings.length === 1 && g.items[1]!.developer)
    check("phase items stay out of the task checklist", g.items.every((i) => i.phaseId === null))
    check("phases in order, with their steps", g.phases.map((x) => `${x.number}:${x.steps.length}`).join() === "1:2,2:1")
    check("phase checklist with its finding", g.phases[0]!.items.length === 1 && g.phases[0]!.items[0]!.findings[0]!.body === "kind http | sql")
    const pr = progress(g)
    check("progress: 2 phases, 1 of 3 steps done", pr.phases === 2 && pr.steps === 3 && pr.done === 1, pr)
    const md = taskMarkdown(g)
    check("markdown: task, checklist, phases, steps", md.startsWith("# Tool count") && md.includes("- [x] Where is the connections page?")
      && md.includes("- [ ] (for you) Count drafts too?") && md.includes("## Phase 2: Show it") && md.includes("### Step 1.2: Tests"), md.slice(0, 300))

    console.log("task tools (as OpenCode calls them, by session)")
    await taskTools(p.project.id)

    console.log("profile")
    await saveProfile(p.project.id, { profile: "Source roots: web/src", verifyCommands: ["npx tsc --noEmit", " "], protectedBranches: ["main", "", "master"] })
    const row = await prisma.project.findUniqueOrThrow({ where: { id: p.project.id } })
    check("saved (blank entries dropped)", row.verifyCommands.join() === "npx tsc --noEmit" && row.protectedBranches.join() === "main,master" && row.profile === "Source roots: web/src")

    console.log("removal")
    await removeTask(s)
    const left = await Promise.all([prisma.taskPhase.count({ where: { taskId: s } }), prisma.taskItem.count({ where: { taskId: s } }), prisma.taskFinding.count({ where: { taskId: s } }), prisma.taskStep.count({ where: { phaseId: { in: [ph1.id, ph2.id] } } })])
    check("a removed task takes its phases, steps, items and findings", left.join() === "0,0,0,0", left)
  } finally {
    const r = await removeProject(p.project.id, null)
    check("project removed (its tasks with it)", r.ok && (await prisma.task.count({ where: { projectId: p.project.id } })) === 0)
  }
}

async function tool(name: Parameters<typeof handleTaskTool>[0], session: string, args: Record<string, unknown>) {
  try { return { ok: true as const, ...(await handleTaskTool(name, session, args)) } } catch (e) { return { ok: false as const, message: (e as Error).message } }
}

async function taskTools(projectId: string) {
  const st = await createTask(projectId, null, { title: "Tools test", request: "Exercise the task tools." })
  if (!st.ok) { check("task for the tools", false, st); return }
  const s = st.task.id
  const sid = (k: string) => `ses_selftest_${k}_${Date.now() % 1000000}`
  const job = async (kind: string, extra: Record<string, string | null> = {}) => {
    const sessionId = sid(kind)
    await prisma.taskJob.create({ data: { taskId: s, kind, sessionId, ...extra } })
    return sessionId
  }
  check("a session that is not a task session is refused", !(await tool("item_add", "ses_nobody", { text: "x" })).ok)

  const c = await job("task-checklist")
  const a1 = await tool("item_add", c, { text: "Where is the connections page?" })
  const a2 = await tool("item_add", c, { text: "Count drafts too? (a) yes (b) no", forDeveloper: true })
  check("task-checklist: item_add twice, numbered 1 and 2", a1.ok && a2.ok && a2.output.includes("item 2") && a2.output.includes("developer"), [a1, a2])
  const wrong = await tool("phase_add", c, { title: "x", goal: "y" })
  check("…and phase_add is refused there, saying which tools fit", !wrong.ok && wrong.message.includes("task_read, item_add"), wrong)

  const item1 = await prisma.taskItem.findFirstOrThrow({ where: { taskId: s, position: 1 } })
  const q = await job("task-item", { itemId: item1.id })
  const f = await tool("finding_add", q, { heading: "Connections page", body: "web/src/app/settings/connections/page.tsx — grep: ConnectionsTab" })
  const k = await tool("item_check", q, { note: "It is ConnectionsTab in page.tsx." })
  const it = await prisma.taskItem.findUniqueOrThrow({ where: { id: item1.id }, include: { findings: true } })
  check("task-item: finding under its item, then checked with the answer as a finding", f.ok && k.ok && it.checked && it.findings.length === 2 && it.findings[1]!.heading === "Answer", [f, k])
  const open2 = await tool("item_check", q, { item: 2, answered: false, note: "Needs the developer." })
  const it2 = await prisma.taskItem.findFirstOrThrow({ where: { taskId: s, position: 2 }, include: { findings: true } })
  check("item_check answered:false leaves it open with the note", open2.ok && !it2.checked && it2.findings[0]?.heading === "Still open", open2)
  check("an item that does not exist is refused", !(await tool("finding_add", q, { item: 9, body: "x" })).ok)

  const ph = await job("task-phases")
  const sp = await tool("task_plan_set", ph, { overview: "Count, then show.", outOfScope: "Tools page." })
  const p1 = await tool("phase_add", ph, { title: "Count", goal: "A count per connection.", approach: "connection-actions.ts" })
  const p2 = await tool("phase_add", ph, { title: "Show", goal: "The count on the page." })
  const task = await prisma.task.findUniqueOrThrow({ where: { id: s }, include: { phases: { orderBy: { number: "asc" } } } })
  check("task-phases: plan saved, phases 1 and 2 added", sp.ok && p1.ok && p2.ok && task.overview === "Count, then show." && task.phases.map((x) => x.title).join() === "Count,Show", [sp, p1, p2])
  check("phase_add without a goal is refused", !(await tool("phase_add", ph, { title: "x" })).ok)

  const phase1 = task.phases[0]!
  const pc = await job("phase-checklist", { phaseId: phase1.id })
  await tool("item_add", pc, { text: "How are bindings shaped?" })
  check("phase-checklist: the item goes to the phase, numbered 1 there", (await prisma.taskItem.findFirst({ where: { phaseId: phase1.id, position: 1 } }))?.text === "How are bindings shaped?")
  const pst = await job("phase-steps", { phaseId: phase1.id })
  const s1 = await tool("step_add", pst, { title: "Count function", files: "a.ts", goal: "Add it.", readBudget: "grep -n 'listConnections' a.ts ±30", context: "export async function listConnections()", changes: "1. In a.ts at listConnections: add toolCountsByConnection." })
  const s2 = await tool("step_add", pst, { title: "Check it", goal: "Look.", changes: "none", needsCheck: true, manualCheck: "Open the page." })
  check("phase-steps: steps 1.1 and 1.2", s1.ok && s1.output.includes("1.1") && s2.ok && s2.output.includes("1.2"), [s1, s2])
  check("step_add without changes is refused", !(await tool("step_add", pst, { title: "x", goal: "y" })).ok)

  const step = await prisma.taskStep.findFirstOrThrow({ where: { phaseId: phase1.id, number: 1 } })
  const sj = await job("step", { phaseId: phase1.id, stepId: step.id })
  const r1 = await tool("task_read", sj, { part: "step", number: "1.1" })
  check("task_read step 1.1: the step's full text", r1.ok && r1.output.includes("# Step 1.1: Count function") && r1.output.includes("toolCountsByConnection"), r1)
  const r2 = await tool("task_read", sj, { part: "task" })
  check("task_read task: request, checklist with findings, phases", r2.ok && r2.output.includes("Exercise the task tools.") && r2.output.includes("ConnectionsTab") && r2.output.includes("1. Count"), r2)
  check("task_read of a phase that does not exist is refused", !(await tool("task_read", sj, { part: "phase", number: "9" })).ok)
  const n = await tool("step_note", sj, { text: "edited a.ts: added toolCountsByConnection" })
  const fin = await tool("step_finish", sj, { status: "done", summary: "a.ts changed." })
  const st1 = await prisma.taskStep.findUniqueOrThrow({ where: { id: step.id } })
  check("step: note then done (verifying until MAW's verify passes); result keeps both", n.ok && fin.ok && st1.status === "verifying" && st1.result.includes("- edited a.ts") && st1.result.includes("Done: a.ts changed."), st1)
  check("step_finish with another status is refused", !(await tool("step_finish", sj, { status: "maybe", summary: "x" })).ok)
  await prisma.taskJob.update({ where: { sessionId: sj }, data: { state: "done" } })
  check("an ended session's tools are refused", !(await tool("step_note", sj, { text: "late" })).ok)

  check("git writes found", gitWrites("git status && git commit -m x; git -C /opt/caw push origin main").join() === "commit,push", gitWrites("git status && git commit -m x; git -C /opt/caw push origin main"))
  check("read-only git passes", gitWrites("git status --short; git diff HEAD | head; git log --oneline -3; git show HEAD:a.ts").length === 0)
  check("git -c … checkout and a branch in a pipe are caught", gitWrites("cd web && git -c user.name=x checkout -b y").join() === "checkout" && gitWrites("echo x | git branch -D y").join() === "branch")
  check("words that only contain git are not git", gitWrites("echo digit commit; legit push").length === 0)
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === "check" && a && b) await run(a, b)
  else throw new Error("usage: tasks-selftest.ts check <machine id> <root>")
  console.log(failed === 0 ? "PASS" : `FAIL (${failed})`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
