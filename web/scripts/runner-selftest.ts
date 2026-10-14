/**
 * Self-test for MAW's runner (lib/task-runner.ts): task planning through
 * OpenCode and the mock model, from the task checklist to "Phases ready",
 * on a temporary project (selftest-runner-*), removed at the end. The task
 * requests carry the mock's cues ("WHEN task-item, item 1 CALL …"), so each
 * kind of session does its own part.
 *   blocked   a checklist session that adds nothing → blocked; Retry
 *   pause     a session running `sleep 30`, paused → stopped; Resume
 *   planning  checklist → items (one answered, one handed to the developer
 *             after 3 sessions, one for the developer) → waits → answers →
 *             phases → phases-ready → Plan again (with a direction) → Approve
 *   phases    phase 1: waits for Plan steps; phase 2 refused first; Plan
 *             steps with a direction → phase checklist → item → your answer
 *             → steps → steps-ready → Plan again → Approve steps; Pause and
 *             Resume while in progress; phase 2: no steps → blocked → Retry
 *   steps     (a git repo in the folder) waits on the protected branch; on
 *             the task's branch: step 1.1's verify fails, MAW's repair
 *             session fixes it (verified, diff kept); 1.2 needs your check
 *             (not right → again → checked); 1.3 fails its verify three
 *             times (the step and both repairs) → blocked → Try again with
 *             a direction → done;
 *             1.4 blocked by the model → Mark done → phase and task done
 * Usage: runner-selftest.ts <machine id> <root>
 * Environment: MAW_OPENCODE_URL, MAW_OPENCODE_PASSWORD, MAW_WORKSPACES_DIR.
 */

import { prisma } from "../lib/prisma"
import { createProject, removeProject } from "../lib/projects"
import { createTask, getTask, saveProfile } from "../lib/tasks"
import { ocMessages, ocStatus, type OcMessage } from "../lib/opencode"
import { workspacePath } from "../lib/workspace"
import {
  ITEM_SESSIONS, approvePhases, approveSteps, checkStep, forgetBranchChecks, heartbeat, markStepDone, pauseTask, phaseAction, planPhase,
  planningAction, reopenStep, replanPhases, replanSteps, resumeTask, retryStep, runnerSeen, runnerTick, setTaskBranch, stopTaskJobs,
} from "../lib/task-runner"
import { runOnMachine } from "../lib/task-steps"
import { toneFor, type TaskAlert } from "../lib/alert-tones"
import { taskAlerts } from "../lib/alerts"
import { checklistPrompt } from "../lib/task-prompts"

let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  const d = detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}`
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : d}`)
  if (!ok) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const lines: string[] = []
const log = (l: string) => { lines.push(l); console.log(`       runner: ${l}`) }

/** Turns the runner until `until` holds (or the limit). */
async function turn(projectId: string, until: () => Promise<boolean>, limitMs = 180_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < limitMs) {
    if (await until()) return true
    await runnerTick(log, projectId)
    await sleep(700)
  }
  return until()
}
const status = async (id: string) => (await prisma.task.findUnique({ where: { id }, select: { status: true } }))?.status
const jobs = (taskId: string) => prisma.taskJob.findMany({ where: { taskId }, orderBy: { createdAt: "asc" }, include: { item: { select: { position: true } } } })
const userText = (ms: OcMessage[]) => ms.filter((m) => m.info.role === "user").flatMap((m) => m.parts).map((p) => p.text ?? "").join("\n")

const REQUEST = [
  "Count the tools of each connection and show the count on the connections page.",
  'WHEN task-checklist CALL item_add {"text":"Where are connections listed?"}',
  'WHEN task-checklist CALL item_add {"text":"What should the column be called?","forDeveloper":true}',
  'WHEN task-checklist CALL item_add {"text":"How are tools counted today?"}',
  'WHEN task-item, item 1 CALL write {"filePath":"runner-note.txt","content":"x"}',
  'WHEN task-item, item 1 CALL finding_add {"heading":"Connections page","body":"web/src/app/connections/page.tsx:12 — ConnectionsTable"}',
  'WHEN task-item, item 1 CALL item_check {"answered":true,"note":"On the connections page."}',
  'WHEN task-item, item 3 CALL item_check {"answered":false,"note":"Half way."}',
  'WHEN task-phases CALL task_plan_set {"overview":"Count, then show.","outOfScope":"No schema change."}',
  'WHEN task-phases CALL phase_add {"title":"Count","goal":"A function that counts a connection\'s tools."}',
  'WHEN task-phases CALL phase_add {"title":"Show","goal":"The count column on the connections page."}',
].join("\n")

async function blocked(projectId: string) {
  console.log("a checklist session that records nothing")
  const st = await createTask(projectId, null, { title: "Nothing recorded", request: "Answer slowly, please." })
  if (!st.ok) { check("task", false, st); return }
  const id = st.task.id
  await turn(projectId, async () => (await status(id)) !== "planning", 90_000)
  const js = await jobs(id)
  check("task blocked", (await status(id)) === "blocked", await status(id))
  check("its checklist job failed, saying why", js.length === 1 && js[0]!.kind === "task-checklist" && js[0]!.state === "failed" && js[0]!.note.includes("without adding any checklist items"), js)
  check("the runner leaves a blocked task alone", (await runnerTick(log, projectId)) === "idle")
  check("Retry: back to planning", (await resumeTask(id)).ok && (await status(id)) === "planning")
  await stopTaskJobs(id, "test")
  await prisma.task.delete({ where: { id } })
}

async function pause(projectId: string, slug: string) {
  console.log("pause and resume")
  const st = await createTask(projectId, null, { title: "Long session", request: "Take a sleep first." })
  if (!st.ok) { check("task", false, st); return }
  const id = st.task.id
  check("the runner starts the checklist session", (await runnerTick(log, projectId)) === "started")
  const job = await prisma.taskJob.findFirst({ where: { taskId: id } })
  let busy = false
  for (let i = 0; i < 60 && !busy && job; i++) {
    await sleep(500)
    const s = await ocStatus(workspacePath(slug))
    busy = s.ok && s.data[job.sessionId]?.type === "busy"
  }
  await sleep(2000)
  check("the session is working", busy)
  check("the session is one of the project's sessions", !!job && !!(await prisma.projectSession.findUnique({ where: { id: job.sessionId } })))
  check("one job at a time: the next turn only watches it", (await runnerTick(log, projectId)) === "busy" && (await prisma.taskJob.count({ where: { taskId: id } })) === 1)
  check("Pause accepted", (await pauseTask(id)).ok)
  const j2 = job ? await prisma.taskJob.findUnique({ where: { id: job.id } }) : null
  check("…the job is stopped, the task paused", j2?.state === "stopped" && (await status(id)) === "paused", j2)
  let idle = false
  for (let i = 0; i < 40 && !idle && job; i++) {
    await sleep(500)
    const s = await ocStatus(workspacePath(slug))
    idle = s.ok && !s.data[job.sessionId]
  }
  check("…and the session was aborted in OpenCode", idle)
  check("Pause twice: refused (already paused)", !(await pauseTask(id)).ok)
  check("Resume: back to planning", (await resumeTask(id)).ok && (await status(id)) === "planning")
  await stopTaskJobs(id, "test")
  await prisma.task.delete({ where: { id } })
}

async function planning(projectId: string, slug: string) {
  console.log("task planning, checklist to phases")
  const st = await createTask(projectId, null, { title: "Tool count", request: REQUEST, branch: "task-tool-count" })
  if (!st.ok) { check("task", false, st); return }
  const id = st.task.id
  // Phase planning's cues name this task's number ("phase-steps, task 3, phase 1").
  const n = st.task.number
  await prisma.task.update({ where: { id }, data: { request: [REQUEST,
    `WHEN phase-checklist, task ${n}, phase 1 CALL item_add {"text":"Where is listConnections?"}`,
    `WHEN phase-checklist, task ${n}, phase 1 CALL item_add {"text":"Badge text: (A) N tools (B) N tool(s)?","forDeveloper":true}`,
    `WHEN phase-item, task ${n}, phase 1 CALL finding_add {"heading":"listConnections","body":"connection-actions.ts:144"}`,
    `WHEN phase-item, task ${n}, phase 1 CALL item_check {"answered":true,"note":"At line 144."}`,
    `WHEN phase-steps, task ${n}, phase 1 CALL step_add {"title":"Count on the server","files":"connection-actions.ts","goal":"toolCount filled","changes":"1. Add the helper."}`,
    `WHEN phase-steps, task ${n}, phase 1 CALL step_add {"title":"Show the badge","files":"ConnectionsManager.tsx","goal":"N tools shown","changes":"1. Add the span.","manualCheck":"Open settings/connections.","needsCheck":true}`,
    `WHEN phase-checklist, task ${n}, phase 2 CALL task_read {"part":"phase","number":"2"}`,
    `WHEN phase-steps, task ${n}, phase 2 CALL task_read {"part":"task"}`,
  ].join("\n") } })
  const first = (await getTask(id))!
  const p0 = checklistPrompt(first)
  check("checklist prompt: session line, profile, request, the AGENTS.md note", p0.startsWith("Session: task-checklist, task ") && p0.includes("Uses Prisma 7.") && p0.includes("Count the tools of each connection") && p0.includes("handoff files"), p0.slice(0, 400))
  check("no word in the prompt sets off the mock's other cues", !/\bask\b|sleep|slow|git status/.test(p0.replace(/^WHEN .*$/gm, "")))

  const waiting = async () => (await prisma.taskJob.count({ where: { taskId: id, state: "running" } })) === 0 && (await planningAction((await getTask(id))!)).kind === "wait"
  await turn(projectId, async () => (await status(id)) !== "planning" || await waiting(), 240_000)
  let s = (await getTask(id))!
  const js = await jobs(id)
  check("still planning, waiting for you", s.status === "planning" && await waiting(), s.status)
  check("3 checklist items, item 2 for you", s.items.length === 3 && s.items[1]!.developer && !s.items[0]!.developer, s.items.map((q) => [q.position, q.developer, q.checked]))
  check("item 1 answered with its finding and answer", s.items[0]!.checked && s.items[0]!.findings.some((f) => f.heading === "Connections page") && s.items[0]!.findings.some((f) => f.heading === "Answer"))
  check(`item 3 left open ${ITEM_SESSIONS} times, then handed to you`, !s.items[2]!.checked && s.items[2]!.developer && s.items[2]!.findings.filter((f) => f.heading === "Still open").length === ITEM_SESSIONS && s.items[2]!.findings.some((f) => f.heading === "Handed to you"), s.items[2])
  check("jobs: checklist, item 1, item 3 ×3 — all done, one at a time", js.map((j) => `${j.kind}${j.item ? j.item.position : ""}:${j.state}`).join() === "task-checklist:done,task-item1:done,task-item3:done,task-item3:done,task-item3:done", js.map((j) => `${j.kind}${j.item?.position ?? ""}:${j.state}`))
  check("each job's session has its title", (await prisma.projectSession.findMany({ where: { id: { in: js.map((j) => j.sessionId) } } })).map((x) => x.title).sort().join("|") === [`${s.title} · checklist`, `${s.title} · item 1`, ...Array(3).fill(`${s.title} · item 3`)].sort().join("|"))
  check("no developer item was given a session", !js.some((j) => j.item?.position === 2))
  const it1 = js.find((j) => j.item?.position === 1)
  const m1 = it1 ? await ocMessages(workspacePath(slug), it1.sessionId) : null
  const w = m1?.ok ? m1.data.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "write") : undefined
  check("a planning session cannot write files", w?.state?.status === "error" && (w.state.error ?? "").includes("planning session"), w?.state)
  const m3 = js[2] ? await ocMessages(workspacePath(slug), js[2].sessionId) : null
  check("item 3's first prompt carries item 1's finding", m3?.ok === true && userText(m3.data).includes("ConnectionsTable") && userText(m3.data).startsWith("Session: task-item, item 3."))
  const m4 = js[3] ? await ocMessages(workspacePath(slug), js[3].sessionId) : null
  check("item 3's next prompt carries the earlier note", m4?.ok === true && userText(m4.data).includes("What earlier sessions recorded on this item") && userText(m4.data).includes("Half way."))
  check("the runner is idle while you answer", (await runnerTick(log, projectId)) === "idle")

  for (const q of s.items.filter((x) => !x.checked)) await prisma.taskItem.update({ where: { id: q.id }, data: { answer: `Answer ${q.position}`, checked: true, checkedAt: new Date() } })
  await turn(projectId, async () => (await status(id)) !== "planning", 120_000)
  s = (await getTask(id))!
  check("phases ready for you", s.status === "phases-ready", s.status)
  check("overview, out of scope and 2 phases", s.overview === "Count, then show." && s.outOfScope === "No schema change." && s.phases.map((p) => p.title).join() === "Count,Show", { o: s.overview, p: s.phases.map((p) => p.title) })
  const ph = (await jobs(id)).filter((j) => j.kind === "task-phases")
  const mp = ph[0] ? await ocMessages(workspacePath(slug), ph[0].sessionId) : null
  check("the phases prompt carries your answers", mp?.ok === true && userText(mp.data).includes("Developer's answer (follow it exactly; it overrides anything above that disagrees): Answer 2"))
  check("the runner leaves it there", (await runnerTick(log, projectId)) === "idle")

  check("Plan again, with a direction", (await replanPhases(id, "Make the count phase first.")).ok && (await status(id)) === "planning")
  await turn(projectId, async () => (await status(id)) !== "planning", 120_000)
  s = (await getTask(id))!
  const ph2 = (await jobs(id)).filter((j) => j.kind === "task-phases")
  const mp2 = ph2[1] ? await ocMessages(workspacePath(slug), ph2[1].sessionId) : null
  check("…phases planned again: still 2 (the old ones replaced)", s.status === "phases-ready" && s.phases.length === 2 && ph2.length === 2, { st: s.status, n: s.phases.length })
  check("…and the new prompt carries your direction", mp2?.ok === true && userText(mp2.data).includes("Make the count phase first."))
  check("Approve phases: in progress", (await approvePhases(id)).ok && (await status(id)) === "in-progress")
  check("Approve twice: refused", !(await approvePhases(id)).ok)
  return id
}

async function phases(projectId: string, slug: string, id: string) {
  console.log("phase planning, phase checklist to steps")
  let s = (await getTask(id))!
  const [p1, p2] = s.phases
  if (!p1 || !p2) { check("two phases to plan", false); return }
  const ph = async (pid: string) => (await prisma.taskPhase.findUniqueOrThrow({ where: { id: pid } })).status
  check("phase 1 waits for you (Plan steps)", (await phaseAction(s)).kind === "wait" && (await runnerTick(log, projectId)) === "idle")
  const early = await planPhase(p2.id, "")
  check("phase 2 cannot be planned before phase 1", !early.ok && early.message.includes("Phase 1 comes first"), early)
  check("Plan steps (with a direction): phase 1 planning", (await planPhase(p1.id, "Fetch only the binding column.")).ok && (await ph(p1.id)) === "planning")
  check("Plan steps twice: refused", !(await planPhase(p1.id, "")).ok)

  const waiting = async () => (await prisma.taskJob.count({ where: { taskId: id, state: "running" } })) === 0 && (await phaseAction((await getTask(id))!)).kind === "wait"
  await turn(projectId, async () => (await status(id)) !== "in-progress" || await waiting(), 180_000)
  s = (await getTask(id))!
  let q1 = s.phases[0]!
  const js = (await jobs(id)).filter((j) => j.phaseId === p1.id)
  check("phase checklist: your direction, then 2 items (item 3 for you)", q1.items.length === 3 && q1.items[0]!.answer === "Fetch only the binding column." && !q1.items[1]!.developer && q1.items[2]!.developer, q1.items.map((q) => [q.position, q.text.slice(0, 30), q.developer, q.checked]))
  check("item 2 answered with its finding", q1.items[1]!.checked && q1.items[1]!.findings.some((f) => f.heading === "listConnections"))
  check("jobs: phase checklist, phase item 2 — done", js.map((j) => `${j.kind}${j.item ? j.item.position : ""}:${j.state}`).join() === "phase-checklist:done,phase-item2:done", js.map((j) => `${j.kind}${j.item?.position ?? ""}:${j.state}`))
  check("session titles name the phase", (await prisma.projectSession.findMany({ where: { id: { in: js.map((j) => j.sessionId) } } })).map((x) => x.title).sort().join("|") === [`${s.title} · phase 1 checklist`, `${s.title} · phase 1 item 2`].sort().join("|"))
  const mc = js[0] ? await ocMessages(workspacePath(slug), js[0].sessionId) : null
  const pc = mc?.ok ? userText(mc.data) : ""
  check("phase checklist prompt: task plan, this phase, your direction, the task's answers", pc.startsWith(`Session: phase-checklist, task ${s.number}, phase 1.`) && pc.includes("Count, then show.") && pc.includes("← this session's phase") && pc.includes("Fetch only the binding column.") && pc.includes("ConnectionsTable"), pc.slice(0, 300))
  check("no word in the phase prompts sets off the mock's other cues", !/\bask\b|sleep|slow|git status/.test(pc.replace(/^WHEN .*$/gm, "")))
  check("waiting for your phase item", s.status === "in-progress" && await waiting() && (await ph(p1.id)) === "planning")

  await prisma.taskItem.update({ where: { id: q1.items[2]!.id }, data: { answer: "A", checked: true, checkedAt: new Date() } })
  await turn(projectId, async () => (await ph(p1.id)) !== "planning", 120_000)
  s = (await getTask(id))!
  q1 = s.phases[0]!
  check("steps ready for you: 2 steps, the second needs your check", q1.status === "steps-ready" && q1.steps.length === 2 && !q1.steps[0]!.check && q1.steps[1]!.check && q1.steps[1]!.manualCheck === "Open settings/connections.", q1.steps.map((x) => [x.number, x.title, x.check]))
  const sj = (await jobs(id)).filter((j) => j.kind === "phase-steps")
  const ms = sj[0] ? await ocMessages(workspacePath(slug), sj[0].sessionId) : null
  const sp = ms?.ok ? userText(ms.data) : ""
  check("steps prompt: the phase's answers, your direction and answer, the step rules", sp.includes("At line 144.") && sp.includes("Fetch only the binding column.") && sp.includes("Developer's answer (follow it exactly") && sp.includes("readBudget") && sp.includes("65,536"), sp.slice(0, 300))
  check("the runner leaves it there", (await runnerTick(log, projectId)) === "idle")

  check("Plan again (steps), with a direction", (await replanSteps(p1.id, "Keep two steps.")).ok && (await ph(p1.id)) === "planning")
  await turn(projectId, async () => (await ph(p1.id)) !== "planning", 120_000)
  s = (await getTask(id))!
  const sj2 = (await jobs(id)).filter((j) => j.phaseId === p1.id)
  check("…only the steps were planned again (checklist kept), steps replaced", s.phases[0]!.status === "steps-ready" && s.phases[0]!.steps.length === 2 && sj2.filter((j) => j.kind === "phase-checklist").length === 1 && sj2.filter((j) => j.kind === "phase-steps").length === 2, sj2.map((j) => j.kind))
  const ms2 = sj2.at(-1) ? await ocMessages(workspacePath(slug), sj2.at(-1)!.sessionId) : null
  check("…and the new prompt carries the new direction", ms2?.ok === true && userText(ms2.data).includes("Keep two steps."))
  check("Approve steps: phase 1 in progress", (await approveSteps(p1.id)).ok && (await ph(p1.id)) === "in-progress")
  check("Approve steps twice: refused", !(await approveSteps(p1.id)).ok)
  // The test folder may sit inside a git checkout (on .201 it is under /opt/maw, on main):
  // no protected branches here, so the branch check lets the step start.
  // The branch check itself is tested in steps().
  // The task's branch is whatever the folder is on (or any name when it is no git project).
  const pr = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { machine: true } })
  const on = await runOnMachine(pr.machine, pr.root, "git rev-parse --abbrev-ref HEAD", 30)
  await prisma.task.update({ where: { id }, data: { branch: on.ok ? on.text.trim().split("\n").at(-1)! : "task-tool-count" } })
  await saveProfile(projectId, { profile: "Uses Prisma 7.", verifyCommands: ["true"], protectedBranches: [] })
  forgetBranchChecks()
  check("approved steps: the runner starts step 1.1", (await runnerTick(log, projectId)) === "started")

  check("Pause while in progress: the step session is stopped", (await pauseTask(id)).ok && (await status(id)) === "paused" && (await prisma.taskJob.count({ where: { taskId: id, state: "running" } })) === 0)
  check("Resume: back to in progress (not planning)", (await resumeTask(id)).ok && (await status(id)) === "in-progress")

  console.log("phase 2: a steps session that adds nothing")
  await prisma.taskPhase.update({ where: { id: p1.id }, data: { status: "done" } }) // as step 07 will
  check("Plan steps: phase 2", (await planPhase(p2.id, "")).ok)
  await turn(projectId, async () => (await status(id)) !== "in-progress", 120_000)
  const j2 = (await jobs(id)).filter((j) => j.phaseId === p2.id)
  check("phase 2: checklist with nothing to add, then steps failed → blocked", (await status(id)) === "blocked" && j2.map((j) => `${j.kind}:${j.state}`).join() === "phase-checklist:done,phase-steps:failed" && j2[0]!.note === "nothing to add" && j2[1]!.note.includes("without adding any steps"), j2.map((j) => [j.kind, j.state, j.note]))
  check("Retry: back to in progress, phase 2 still planning", (await resumeTask(id)).ok && (await status(id)) === "in-progress" && (await ph(p2.id)) === "planning")
  await stopTaskJobs(id, "test")
  await pauseTask(id) // out of the way of the steps test
}

async function steps(projectId: string, slug: string, root: string) {
  console.log("carrying out steps")
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { machine: true } })
  const sh = (c: string) => runOnMachine(p.machine, root, c, 60)
  const g = await sh("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git rev-parse --abbrev-ref HEAD")
  check("a git repository on main in the test folder", g.ok && g.text.trim().endsWith("main"), g)
  await saveProfile(projectId, { profile: "Uses Prisma 7.", verifyCommands: ["test -f step-a.txt", "! grep -q BROKEN step-c.txt 2>/dev/null"], protectedBranches: ["main"], deployCommand: "echo deployed >> deploys.txt" })
  const st = await createTask(projectId, null, { title: "Steps", request: "Carry out the steps.", branch: "task-x" })
  if (!st.ok) { check("task", false, st); return }
  const id = st.task.id
  const N = st.task.number
  const cue = (step: string, tool: string, args: unknown, when = `step, task ${N}, step ${step}`) => `WHEN ${when} CALL ${tool} ${JSON.stringify(args)}`
  await prisma.task.update({ where: { id }, data: {
    status: "in-progress", overview: "Four small steps.", notes: "Keep it small.",
    request: ["Carry out the steps.",
      cue("1.1", "bash", { command: "docker compose up -d --build", timeout: 60000 }),
      // 1.1: the first session forgets the file, so the verify fails; MAW's repair session writes it.
      cue("1.1", "write", { filePath: "step-a.txt", content: "a\n" }, "Repair 1 of 2 for step 1.1"), cue("1.1", "step_note", { text: "step-a.txt: written" }, "Repair 1 of 2 for step 1.1"),
      cue("1.1", "step_finish", { status: "done", summary: "wrote step-a.txt" }),
      cue("1.2", "write", { filePath: "step-b.txt", content: "b\n" }), cue("1.2", "step_finish", { status: "done", summary: "wrote step-b.txt" }),
      // 1.3: every session writes BROKEN (the verify fails), so both repairs fail and the step is blocked; your Try again fixes it.
      cue("1.3", "write", { filePath: "step-c.txt", content: "BROKEN\n" }), cue("1.3", "write", { filePath: "step-c.txt", content: "fine\n" }, "Developer: fix it"),
      cue("1.3", "step_finish", { status: "done", summary: "wrote step-c.txt" }),
      cue("1.4", "step_finish", { status: "blocked", summary: "needs a key only you have" }),
    ].join("\n") } })
  const ph = await prisma.taskPhase.create({ data: { taskId: id, number: 1, title: "Do it", goal: "Four files.", status: "in-progress" } })
  const mk = (n: number, title: string, check = false, deploy = false) => prisma.taskStep.create({ data: { phaseId: ph.id, number: n, title, goal: title, changes: `1. ${title}.`, check, deploy, manualCheck: check ? "Look at step-b.txt." : "" } })
  const s1 = await mk(1, "Write a"), s2 = await mk(2, "Write b", true), s3 = await mk(3, "Write c", false, true), s4 = await mk(4, "Needs a key")
  await prisma.taskItem.create({ data: { taskId: id, phaseId: ph.id, position: 1, text: "Your direction for phase 1's steps", developer: true, answer: "Use small files.", checked: true } })
  const step = (sid: string) => prisma.taskStep.findUniqueOrThrow({ where: { id: sid } })
  const sjobs = async (sid: string) => prisma.taskJob.findMany({ where: { stepId: sid }, orderBy: { createdAt: "asc" } })

  await prisma.task.update({ where: { id }, data: { branch: null } })
  check("no branch: the runner waits and asks for one", (await runnerTick(log, projectId)) === "idle" && (await prisma.task.findUniqueOrThrow({ where: { id } })).runnerNote.includes("has no branch"))
  check("a bad branch name is refused", !(await setTaskBranch(id, "bad branch")).ok)
  check("the branch set from the Dashboard", (await setTaskBranch(id, "task-x")).ok && (await prisma.task.findUniqueOrThrow({ where: { id } })).runnerNote === "")
  forgetBranchChecks()
  check("on main (protected): the runner waits and says why", (await runnerTick(log, projectId)) === "idle" && (await prisma.task.findUniqueOrThrow({ where: { id } })).runnerNote.includes("main, a protected branch"))
  await sh("git checkout -q -b task-x")
  forgetBranchChecks()
  await turn(projectId, async () => (await step(s2.id)).status === "waiting-check" || (await status(id)) !== "in-progress", 180_000)
  const a = await step(s1.id)
  check("the wait note is cleared on the task's branch", (await prisma.task.findUniqueOrThrow({ where: { id } })).runnerNote === "")
  check("step 1.1 done: the model's note and finish recorded", a.status === "done" && a.result.includes("- step-a.txt: written") && a.result.includes("Done: wrote step-a.txt"), a)
  check("…verify commands ran and passed", a.verifyOutput.includes("$ test -f step-a.txt") && a.verifyOutput.includes("→ exit 0"), a.verifyOutput)
  check("…its changes are kept (git status and diff)", a.diff.includes("step-a.txt"), a.diff)
  const f = await sh("cat step-a.txt")
  check("…a step session may write files (the file is in the project)", f.ok && f.text.trim() === "a", f)
  const j1 = await sjobs(s1.id)
  check("…the verify failed after the first session: repair 1 of 2 followed", j1.length === 2 && j1[0]!.note.includes("verify failed: test -f step-a.txt; repair 1 of 2 next") && a.result.includes("MAW: the verify command failed: test -f step-a.txt; repair 1 of 2 follows."), j1.map((j) => j.note))
  check("…the repair session titled, its job done and verified; the step's reason cleared", j1[1]?.state === "done" && j1[1].note.includes("verified") && a.repairs === 1 && a.repairReason === ""
    && (await prisma.projectSession.findUnique({ where: { id: j1[0]!.sessionId } }))?.title === "Steps · step 1.1" && (await prisma.projectSession.findUnique({ where: { id: j1[1]!.sessionId } }))?.title === "Steps · step 1.1 · repair 1", j1)
  const m1r = j1[1] ? await ocMessages(workspacePath(slug), j1[1].sessionId) : null
  const p1r = m1r?.ok ? userText(m1r.data) : ""
  check("…the repair prompt names the repair and carries the failing command's output", p1r.includes("## Repair 1 of 2 for step 1.1") && p1r.includes("$ test -f step-a.txt") && p1r.includes("→ exit 1"), p1r.slice(p1r.indexOf("## Repair"), p1r.indexOf("## Repair") + 400))
  check("no word in the repair prompt sets off the mock's other cues", !/\bask\b|sleep|slow|git status/.test(p1r.replace(/^WHEN .*$/gm, "")))
  const m1 = await ocMessages(workspacePath(slug), j1[0]!.sessionId)
  const p1 = m1.ok ? userText(m1.data) : ""
  const dk = m1.ok ? m1.data.flatMap((m) => m.parts).find((x) => x.type === "tool" && x.tool === "bash") : undefined
  check("docker compose up in a step session: refused, nothing run", dk?.state?.status === "error" && (dk.state.error ?? "").includes("MAW deploys the project itself"), dk?.state)
  check("step prompt: your direction after the step text, as overriding it", p1.indexOf("# Step 1.1: Write a") < p1.indexOf("They override the step text") && p1.includes("Use small files."))
  check("a step that is neither checked, marked deploy, nor the phase's last: no deploy", a.deployOutput === "")
  check("step prompt: the task plan, the phase, the step, the task", p1.startsWith(`Session: step, task ${N}, step 1.1.`) && p1.includes("Four small steps.") && p1.includes("# Step 1.1: Write a") && p1.includes("Your task: carry out step 1.1") && !p1.includes("This is planning"), p1.slice(0, 300))
  check("no word in the step prompt sets off the mock's other cues", !/\bask\b|sleep|slow|git status/.test(p1.replace(/^WHEN .*$/gm, "")))

  check("step 1.2 (Check) waits for your check after its verify", (await step(s2.id)).status === "waiting-check" && (await runnerTick(log, projectId)) === "idle")
  check("Not right without a note: refused", !(await checkStep(s2.id, false, "")).ok)
  check("Not right, with a note: the step runs again", (await checkStep(s2.id, false, "use B")).ok && (await step(s2.id)).status === "pending")
  await turn(projectId, async () => (await step(s2.id)).status === "waiting-check", 120_000)
  const j2 = await sjobs(s2.id)
  const m2 = j2[1] ? await ocMessages(workspacePath(slug), j2[1].sessionId) : null
  check("…its second session reads your note", j2.length === 2 && m2?.ok === true && userText(m2.data).includes("Developer: not right: use B"))
  check("a step with a check: MAW deployed before asking", (await step(s2.id)).deployOutput.includes("$ echo deployed >> deploys.txt") && (await step(s2.id)).deployOutput.includes("→ exit 0"))
  check("Checked: step 1.2 done", (await checkStep(s2.id, true, "")).ok && (await step(s2.id)).status === "done")

  await turn(projectId, async () => (await status(id)) !== "in-progress", 120_000)
  let c = await step(s3.id)
  const j3a = await sjobs(s3.id)
  check("step 1.3: the verify fails three times (the step, then both repairs) → step and task blocked", c.status === "blocked" && (await status(id)) === "blocked" && j3a.length === 3 && c.repairs === 2
    && c.verifyOutput.includes("→ exit 1") && c.result.includes("repair 2 of 2 follows.") && c.result.includes("MAW: the verify command failed: ! grep -q BROKEN step-c.txt 2>/dev/null (after 2 repairs)."), { st: c.status, n: j3a.length, r: c.result })
  check("Retry on the task alone does not run a blocked step", (await resumeTask(id)).ok && (await runnerTick(log, projectId)) === "idle" && (await status(id)) === "blocked")
  check("Try again, with a direction: the step is pending, its repairs given back, the task in progress", (await retryStep(s3.id, "fix it")).ok && (await step(s3.id)).status === "pending" && (await step(s3.id)).repairs === 0 && (await status(id)) === "in-progress")
  await turn(projectId, async () => (await step(s3.id)).status === "done" || (await status(id)) !== "in-progress", 120_000)
  c = await step(s3.id)
  const j3 = await sjobs(s3.id)
  const m3 = j3[3] ? await ocMessages(workspacePath(slug), j3[3].sessionId) : null
  check("a step marked deploy: deployed after its verify", c.status === "done" && c.deployOutput.includes("echo deployed"))
  check("…the second session reads the verify output and your direction, and fixes it", c.status === "done" && m3?.ok === true && userText(m3.data).includes("## What failed after the last session") && userText(m3.data).includes("Developer: fix it") && c.repairReason === "", c.status)

  await turn(projectId, async () => (await status(id)) !== "in-progress", 120_000)
  const d = await step(s4.id)
  const j4 = await sjobs(s4.id)
  check("step 1.4 blocked by the model: task blocked, the reason kept", d.status === "blocked" && (await status(id)) === "blocked" && d.result.includes("Blocked: needs a key only you have") && j4[0]?.note.includes("needs a key"), { st: d.status, r: d.result, n: j4[0]?.note })
  check("Mark done: step done, task in progress", (await markStepDone(s4.id)).ok && (await step(s4.id)).status === "done" && (await status(id)) === "in-progress")
  await runnerTick(log, projectId)
  check("every step done → the phase is done → the task is done", (await prisma.taskPhase.findUniqueOrThrow({ where: { id: ph.id } })).status === "done" && (await status(id)) === "done")
  check("the runner leaves a done task alone", (await runnerTick(log, projectId)) === "idle")

  console.log("reopen a done step")
  const before = await taskAlerts()
  check("Reopen without a note: refused", !(await reopenStep(s1.id, "")).ok)
  check("Reopen step 1.1 with a note: step pending, phase and task in progress", (await reopenStep(s1.id, "write a twice")).ok && (await step(s1.id)).status === "pending" && (await status(id)) === "in-progress")
  await turn(projectId, async () => (await status(id)) === "done", 120_000)
  const r1 = await step(s1.id)
  const j1b = await sjobs(s1.id)
  const m1b = j1b.at(-1) ? await ocMessages(workspacePath(slug), j1b.at(-1)!.sessionId) : null
  check("…it ran again with your note and, being the phase's last open step, deployed; the task is done again", r1.status === "done" && r1.deployOutput.includes("echo deployed") && m1b?.ok === true && userText(m1b.data).includes("Developer: reopened: write a twice") && (await status(id)) === "done", { st: r1.status, d: r1.deployOutput.slice(0, 80) })
  const dep = await sh("wc -l < deploys.txt")
  check("deploys ran on the machine, in the project (step 1.2, 1.3 twice?, 1.1 again)", dep.ok && Number(dep.text.trim()) >= 3, dep.text)
  const after = await taskAlerts()
  check("the alerts digest lists the task, done", after.some((x) => x.id === id && x.status === "done") && before.some((x) => x.id === id))
}

function tones() {
  console.log("sounds: which tone for which change")
  const a = (o: Partial<TaskAlert>): TaskAlert => ({ id: "s", project: "p", number: 1, title: "t", status: "in-progress", checks: 0, items: 0, approvals: 0, note: "", ...o })
  const none = { before: new Map<string, string>(), after: new Map<string, string>() }
  check("task done → finished", toneFor([a({})], [a({ status: "done" })], none) === "finished")
  check("task blocked → error", toneFor([a({})], [a({ status: "blocked" })], none) === "error")
  check("a step waits for your check → question", toneFor([a({})], [a({ checks: 1 })], none) === "question")
  check("an item for you → question", toneFor([a({ status: "planning" })], [a({ status: "planning", items: 1 })], none) === "question")
  check("phases ready → stopped", toneFor([a({ status: "planning" })], [a({ status: "phases-ready" })], none) === "stopped")
  check("steps ready / phase to plan → stopped", toneFor([a({})], [a({ approvals: 1 })], none) === "stopped")
  check("a branch to make → stopped", toneFor([a({})], [a({ note: "no branch" })], none) === "stopped")
  check("nothing changed, or you approved → no sound", toneFor([a({})], [a({})], none) === null && toneFor([a({ status: "phases-ready" })], [a({})], none) === null)
  check("a new task → no sound", toneFor([], [a({})], none) === null)
  check("error wins over the rest", toneFor([a({}), a({ id: "x" })], [a({ status: "done" }), a({ id: "x", status: "blocked" })], none) === "error")
  const ses = (b: [string, string][], f: [string, string][]) => ({ before: new Map(b), after: new Map(f) })
  check("your session's turn ends → stopped", toneFor([], [], ses([["a", "working"]], [])) === "stopped")
  check("your session asks → question", toneFor([], [], ses([["a", "working"]], [["a", "waiting"]])) === "question")
  check("your session's model fails (retry) → error", toneFor([], [], ses([["a", "working"]], [["a", "retry"]])) === "error")
  check("answering a question: no sound", toneFor([], [], ses([["a", "waiting"]], [["a", "working"]])) === null)
}

async function main() {
  tones()
  const [machineId, root] = process.argv.slice(2)
  if (!machineId || !root) throw new Error("usage: runner-selftest.ts <machine id> <root>")
  heartbeat()
  const seen = runnerSeen()
  check("heartbeat written and read", !!seen && Date.now() - seen.getTime() < 10_000)
  const p = await createProject({ name: `selftest-runner-${Date.now() % 100000}`, machineId, root }, null)
  if (!p.ok) { check("project for the test", false, p); return finish() }
  try {
    await saveProfile(p.project.id, { profile: "Uses Prisma 7.", verifyCommands: ["true"], protectedBranches: ["main"] })
    await blocked(p.project.id)
    await pause(p.project.id, p.project.slug)
    const id = await planning(p.project.id, p.project.slug)
    if (id) await phases(p.project.id, p.project.slug, id)
    await steps(p.project.id, p.project.slug, root)
  } finally {
    const r = await removeProject(p.project.id, null)
    check("project removed", r.ok)
  }
  return finish()
}
async function finish() {
  console.log(failed === 0 ? "PASS" : `FAIL (${failed})`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
