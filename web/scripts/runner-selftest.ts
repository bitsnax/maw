/**
 * Self-test for MAW's runner (lib/story-runner.ts): story planning through
 * OpenCode and the mock model, from the story checklist to "Phases ready",
 * on a temporary project (selftest-runner-*), removed at the end. The story
 * requests carry the mock's cues ("WHEN story-item, item 1 CALL …"), so each
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
 * Usage: runner-selftest.ts <machine id> <root>
 * Environment: MAW_OPENCODE_URL, MAW_OPENCODE_PASSWORD, MAW_WORKSPACES_DIR.
 */

import { prisma } from "../lib/prisma"
import { createProject, removeProject } from "../lib/projects"
import { createStory, getStory, saveProfile } from "../lib/stories"
import { ocMessages, ocStatus, type OcMessage } from "../lib/opencode"
import { workspacePath } from "../lib/workspace"
import {
  ITEM_SESSIONS, approvePhases, approveSteps, heartbeat, pauseStory, phaseAction, planPhase, planningAction, replanPhases, replanSteps,
  resumeStory, runnerSeen, runnerTick, stopStoryJobs,
} from "../lib/story-runner"
import { checklistPrompt } from "../lib/story-prompts"

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
const status = async (id: string) => (await prisma.story.findUnique({ where: { id }, select: { status: true } }))?.status
const jobs = (storyId: string) => prisma.storyJob.findMany({ where: { storyId }, orderBy: { createdAt: "asc" }, include: { item: { select: { position: true } } } })
const userText = (ms: OcMessage[]) => ms.filter((m) => m.info.role === "user").flatMap((m) => m.parts).map((p) => p.text ?? "").join("\n")

const REQUEST = [
  "Count the tools of each connection and show the count on the connections page.",
  'WHEN story-checklist CALL item_add {"text":"Where are connections listed?"}',
  'WHEN story-checklist CALL item_add {"text":"What should the column be called?","forDeveloper":true}',
  'WHEN story-checklist CALL item_add {"text":"How are tools counted today?"}',
  'WHEN story-item, item 1 CALL write {"filePath":"runner-note.txt","content":"x"}',
  'WHEN story-item, item 1 CALL finding_add {"heading":"Connections page","body":"web/src/app/connections/page.tsx:12 — ConnectionsTable"}',
  'WHEN story-item, item 1 CALL item_check {"answered":true,"note":"On the connections page."}',
  'WHEN story-item, item 3 CALL item_check {"answered":false,"note":"Half way."}',
  'WHEN story-phases CALL story_plan_set {"overview":"Count, then show.","outOfScope":"No schema change."}',
  'WHEN story-phases CALL phase_add {"title":"Count","goal":"A function that counts a connection\'s tools."}',
  'WHEN story-phases CALL phase_add {"title":"Show","goal":"The count column on the connections page."}',
].join("\n")

async function blocked(projectId: string) {
  console.log("a checklist session that records nothing")
  const st = await createStory(projectId, null, { title: "Nothing recorded", request: "Answer slowly, please." })
  if (!st.ok) { check("story", false, st); return }
  const id = st.story.id
  await turn(projectId, async () => (await status(id)) !== "planning", 90_000)
  const js = await jobs(id)
  check("story blocked", (await status(id)) === "blocked", await status(id))
  check("its checklist job failed, saying why", js.length === 1 && js[0]!.kind === "story-checklist" && js[0]!.state === "failed" && js[0]!.note.includes("without adding any checklist items"), js)
  check("the runner leaves a blocked story alone", (await runnerTick(log, projectId)) === "idle")
  check("Retry: back to planning", (await resumeStory(id)).ok && (await status(id)) === "planning")
  await stopStoryJobs(id, "test")
  await prisma.story.delete({ where: { id } })
}

async function pause(projectId: string, slug: string) {
  console.log("pause and resume")
  const st = await createStory(projectId, null, { title: "Long session", request: "Take a sleep first." })
  if (!st.ok) { check("story", false, st); return }
  const id = st.story.id
  check("the runner starts the checklist session", (await runnerTick(log, projectId)) === "started")
  const job = await prisma.storyJob.findFirst({ where: { storyId: id } })
  let busy = false
  for (let i = 0; i < 60 && !busy && job; i++) {
    await sleep(500)
    const s = await ocStatus(workspacePath(slug))
    busy = s.ok && s.data[job.sessionId]?.type === "busy"
  }
  await sleep(2000)
  check("the session is working", busy)
  check("the session is one of the project's sessions", !!job && !!(await prisma.projectSession.findUnique({ where: { id: job.sessionId } })))
  check("one job at a time: the next turn only watches it", (await runnerTick(log, projectId)) === "busy" && (await prisma.storyJob.count({ where: { storyId: id } })) === 1)
  check("Pause accepted", (await pauseStory(id)).ok)
  const j2 = job ? await prisma.storyJob.findUnique({ where: { id: job.id } }) : null
  check("…the job is stopped, the story paused", j2?.state === "stopped" && (await status(id)) === "paused", j2)
  let idle = false
  for (let i = 0; i < 40 && !idle && job; i++) {
    await sleep(500)
    const s = await ocStatus(workspacePath(slug))
    idle = s.ok && !s.data[job.sessionId]
  }
  check("…and the session was aborted in OpenCode", idle)
  check("Pause twice: refused (already paused)", !(await pauseStory(id)).ok)
  check("Resume: back to planning", (await resumeStory(id)).ok && (await status(id)) === "planning")
  await stopStoryJobs(id, "test")
  await prisma.story.delete({ where: { id } })
}

async function planning(projectId: string, slug: string) {
  console.log("story planning, checklist to phases")
  const st = await createStory(projectId, null, { title: "Tool count", request: REQUEST, branch: "story-tool-count" })
  if (!st.ok) { check("story", false, st); return }
  const id = st.story.id
  // Phase planning's cues name this story's number ("phase-steps, story 3, phase 1").
  const n = st.story.number
  await prisma.story.update({ where: { id }, data: { request: [REQUEST,
    `WHEN phase-checklist, story ${n}, phase 1 CALL item_add {"text":"Where is listConnections?"}`,
    `WHEN phase-checklist, story ${n}, phase 1 CALL item_add {"text":"Badge text: (A) N tools (B) N tool(s)?","forDeveloper":true}`,
    `WHEN phase-item, story ${n}, phase 1 CALL finding_add {"heading":"listConnections","body":"connection-actions.ts:144"}`,
    `WHEN phase-item, story ${n}, phase 1 CALL item_check {"answered":true,"note":"At line 144."}`,
    `WHEN phase-steps, story ${n}, phase 1 CALL step_add {"title":"Count on the server","files":"connection-actions.ts","goal":"toolCount filled","changes":"1. Add the helper."}`,
    `WHEN phase-steps, story ${n}, phase 1 CALL step_add {"title":"Show the badge","files":"ConnectionsManager.tsx","goal":"N tools shown","changes":"1. Add the span.","manualCheck":"Open settings/connections.","needsCheck":true}`,
    `WHEN phase-checklist, story ${n}, phase 2 CALL story_read {"part":"phase","number":"2"}`,
    `WHEN phase-steps, story ${n}, phase 2 CALL story_read {"part":"story"}`,
  ].join("\n") } })
  const first = (await getStory(id))!
  const p0 = checklistPrompt(first)
  check("checklist prompt: session line, profile, request, the AGENTS.md note", p0.startsWith("Session: story-checklist, story ") && p0.includes("Uses Prisma 7.") && p0.includes("Count the tools of each connection") && p0.includes("handoff files"), p0.slice(0, 400))
  check("no word in the prompt sets off the mock's other cues", !/\bask\b|sleep|slow|git status/.test(p0.replace(/^WHEN .*$/gm, "")))

  const waiting = async () => (await prisma.storyJob.count({ where: { storyId: id, state: "running" } })) === 0 && (await planningAction((await getStory(id))!)).kind === "wait"
  await turn(projectId, async () => (await status(id)) !== "planning" || await waiting(), 240_000)
  let s = (await getStory(id))!
  const js = await jobs(id)
  check("still planning, waiting for you", s.status === "planning" && await waiting(), s.status)
  check("3 checklist items, item 2 for you", s.items.length === 3 && s.items[1]!.developer && !s.items[0]!.developer, s.items.map((q) => [q.position, q.developer, q.checked]))
  check("item 1 answered with its finding and answer", s.items[0]!.checked && s.items[0]!.findings.some((f) => f.heading === "Connections page") && s.items[0]!.findings.some((f) => f.heading === "Answer"))
  check(`item 3 left open ${ITEM_SESSIONS} times, then handed to you`, !s.items[2]!.checked && s.items[2]!.developer && s.items[2]!.findings.filter((f) => f.heading === "Still open").length === ITEM_SESSIONS && s.items[2]!.findings.some((f) => f.heading === "Handed to you"), s.items[2])
  check("jobs: checklist, item 1, item 3 ×3 — all done, one at a time", js.map((j) => `${j.kind}${j.item ? j.item.position : ""}:${j.state}`).join() === "story-checklist:done,story-item1:done,story-item3:done,story-item3:done,story-item3:done", js.map((j) => `${j.kind}${j.item?.position ?? ""}:${j.state}`))
  check("each job's session has its title", (await prisma.projectSession.findMany({ where: { id: { in: js.map((j) => j.sessionId) } } })).map((x) => x.title).sort().join("|") === [`Story ${s.number} · checklist`, `Story ${s.number} · item 1`, ...Array(3).fill(`Story ${s.number} · item 3`)].sort().join("|"))
  check("no developer item was given a session", !js.some((j) => j.item?.position === 2))
  const it1 = js.find((j) => j.item?.position === 1)
  const m1 = it1 ? await ocMessages(workspacePath(slug), it1.sessionId) : null
  const w = m1?.ok ? m1.data.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "write") : undefined
  check("a planning session cannot write files", w?.state?.status === "error" && (w.state.error ?? "").includes("planning session"), w?.state)
  const m3 = js[2] ? await ocMessages(workspacePath(slug), js[2].sessionId) : null
  check("item 3's first prompt carries item 1's finding", m3?.ok === true && userText(m3.data).includes("ConnectionsTable") && userText(m3.data).startsWith("Session: story-item, item 3."))
  const m4 = js[3] ? await ocMessages(workspacePath(slug), js[3].sessionId) : null
  check("item 3's next prompt carries the earlier note", m4?.ok === true && userText(m4.data).includes("What earlier sessions recorded on this item") && userText(m4.data).includes("Half way."))
  check("the runner is idle while you answer", (await runnerTick(log, projectId)) === "idle")

  for (const q of s.items.filter((x) => !x.checked)) await prisma.storyItem.update({ where: { id: q.id }, data: { answer: `Answer ${q.position}`, checked: true, checkedAt: new Date() } })
  await turn(projectId, async () => (await status(id)) !== "planning", 120_000)
  s = (await getStory(id))!
  check("phases ready for you", s.status === "phases-ready", s.status)
  check("overview, out of scope and 2 phases", s.overview === "Count, then show." && s.outOfScope === "No schema change." && s.phases.map((p) => p.title).join() === "Count,Show", { o: s.overview, p: s.phases.map((p) => p.title) })
  const ph = (await jobs(id)).filter((j) => j.kind === "story-phases")
  const mp = ph[0] ? await ocMessages(workspacePath(slug), ph[0].sessionId) : null
  check("the phases prompt carries your answers", mp?.ok === true && userText(mp.data).includes("Developer's answer (follow it exactly; it overrides anything above that disagrees): Answer 2"))
  check("the runner leaves it there", (await runnerTick(log, projectId)) === "idle")

  check("Plan again, with a direction", (await replanPhases(id, "Make the count phase first.")).ok && (await status(id)) === "planning")
  await turn(projectId, async () => (await status(id)) !== "planning", 120_000)
  s = (await getStory(id))!
  const ph2 = (await jobs(id)).filter((j) => j.kind === "story-phases")
  const mp2 = ph2[1] ? await ocMessages(workspacePath(slug), ph2[1].sessionId) : null
  check("…phases planned again: still 2 (the old ones replaced)", s.status === "phases-ready" && s.phases.length === 2 && ph2.length === 2, { st: s.status, n: s.phases.length })
  check("…and the new prompt carries your direction", mp2?.ok === true && userText(mp2.data).includes("Make the count phase first."))
  check("Approve phases: in progress", (await approvePhases(id)).ok && (await status(id)) === "in-progress")
  check("Approve twice: refused", !(await approvePhases(id)).ok)
  return id
}

async function phases(projectId: string, slug: string, id: string) {
  console.log("phase planning, phase checklist to steps")
  let s = (await getStory(id))!
  const [p1, p2] = s.phases
  if (!p1 || !p2) { check("two phases to plan", false); return }
  const ph = async (pid: string) => (await prisma.storyPhase.findUniqueOrThrow({ where: { id: pid } })).status
  check("phase 1 waits for you (Plan steps)", (await phaseAction(s)).kind === "wait" && (await runnerTick(log, projectId)) === "idle")
  const early = await planPhase(p2.id, "")
  check("phase 2 cannot be planned before phase 1", !early.ok && early.message.includes("Phase 1 comes first"), early)
  check("Plan steps (with a direction): phase 1 planning", (await planPhase(p1.id, "Fetch only the binding column.")).ok && (await ph(p1.id)) === "planning")
  check("Plan steps twice: refused", !(await planPhase(p1.id, "")).ok)

  const waiting = async () => (await prisma.storyJob.count({ where: { storyId: id, state: "running" } })) === 0 && (await phaseAction((await getStory(id))!)).kind === "wait"
  await turn(projectId, async () => (await status(id)) !== "in-progress" || await waiting(), 180_000)
  s = (await getStory(id))!
  let q1 = s.phases[0]!
  const js = (await jobs(id)).filter((j) => j.phaseId === p1.id)
  check("phase checklist: your direction, then 2 items (item 3 for you)", q1.items.length === 3 && q1.items[0]!.answer === "Fetch only the binding column." && !q1.items[1]!.developer && q1.items[2]!.developer, q1.items.map((q) => [q.position, q.text.slice(0, 30), q.developer, q.checked]))
  check("item 2 answered with its finding", q1.items[1]!.checked && q1.items[1]!.findings.some((f) => f.heading === "listConnections"))
  check("jobs: phase checklist, phase item 2 — done", js.map((j) => `${j.kind}${j.item ? j.item.position : ""}:${j.state}`).join() === "phase-checklist:done,phase-item2:done", js.map((j) => `${j.kind}${j.item?.position ?? ""}:${j.state}`))
  check("session titles name the phase", (await prisma.projectSession.findMany({ where: { id: { in: js.map((j) => j.sessionId) } } })).map((x) => x.title).sort().join("|") === [`Story ${s.number} · phase 1 checklist`, `Story ${s.number} · phase 1 item 2`].sort().join("|"))
  const mc = js[0] ? await ocMessages(workspacePath(slug), js[0].sessionId) : null
  const pc = mc?.ok ? userText(mc.data) : ""
  check("phase checklist prompt: story plan, this phase, your direction, the story's answers", pc.startsWith(`Session: phase-checklist, story ${s.number}, phase 1.`) && pc.includes("Count, then show.") && pc.includes("← this session's phase") && pc.includes("Fetch only the binding column.") && pc.includes("ConnectionsTable"), pc.slice(0, 300))
  check("no word in the phase prompts sets off the mock's other cues", !/\bask\b|sleep|slow|git status/.test(pc.replace(/^WHEN .*$/gm, "")))
  check("waiting for your phase item", s.status === "in-progress" && await waiting() && (await ph(p1.id)) === "planning")

  await prisma.storyItem.update({ where: { id: q1.items[2]!.id }, data: { answer: "A", checked: true, checkedAt: new Date() } })
  await turn(projectId, async () => (await ph(p1.id)) !== "planning", 120_000)
  s = (await getStory(id))!
  q1 = s.phases[0]!
  check("steps ready for you: 2 steps, the second needs your check", q1.status === "steps-ready" && q1.steps.length === 2 && !q1.steps[0]!.check && q1.steps[1]!.check && q1.steps[1]!.manualCheck === "Open settings/connections.", q1.steps.map((x) => [x.number, x.title, x.check]))
  const sj = (await jobs(id)).filter((j) => j.kind === "phase-steps")
  const ms = sj[0] ? await ocMessages(workspacePath(slug), sj[0].sessionId) : null
  const sp = ms?.ok ? userText(ms.data) : ""
  check("steps prompt: the phase's answers, your direction and answer, the step rules", sp.includes("At line 144.") && sp.includes("Fetch only the binding column.") && sp.includes("Developer's answer (follow it exactly") && sp.includes("readBudget") && sp.includes("65,536"), sp.slice(0, 300))
  check("the runner leaves it there", (await runnerTick(log, projectId)) === "idle")

  check("Plan again (steps), with a direction", (await replanSteps(p1.id, "Keep two steps.")).ok && (await ph(p1.id)) === "planning")
  await turn(projectId, async () => (await ph(p1.id)) !== "planning", 120_000)
  s = (await getStory(id))!
  const sj2 = (await jobs(id)).filter((j) => j.phaseId === p1.id)
  check("…only the steps were planned again (checklist kept), steps replaced", s.phases[0]!.status === "steps-ready" && s.phases[0]!.steps.length === 2 && sj2.filter((j) => j.kind === "phase-checklist").length === 1 && sj2.filter((j) => j.kind === "phase-steps").length === 2, sj2.map((j) => j.kind))
  const ms2 = sj2.at(-1) ? await ocMessages(workspacePath(slug), sj2.at(-1)!.sessionId) : null
  check("…and the new prompt carries the new direction", ms2?.ok === true && userText(ms2.data).includes("Keep two steps."))
  check("Approve steps: phase 1 in progress", (await approveSteps(p1.id)).ok && (await ph(p1.id)) === "in-progress")
  check("Approve steps twice: refused", !(await approveSteps(p1.id)).ok)
  check("the runner has nothing to do (steps are not carried out yet)", (await runnerTick(log, projectId)) === "idle")

  check("Pause while in progress", (await pauseStory(id)).ok && (await status(id)) === "paused")
  check("Resume: back to in progress (not planning)", (await resumeStory(id)).ok && (await status(id)) === "in-progress")

  console.log("phase 2: a steps session that adds nothing")
  await prisma.storyPhase.update({ where: { id: p1.id }, data: { status: "done" } }) // as step 07 will
  check("Plan steps: phase 2", (await planPhase(p2.id, "")).ok)
  await turn(projectId, async () => (await status(id)) !== "in-progress", 120_000)
  const j2 = (await jobs(id)).filter((j) => j.phaseId === p2.id)
  check("phase 2: checklist with nothing to add, then steps failed → blocked", (await status(id)) === "blocked" && j2.map((j) => `${j.kind}:${j.state}`).join() === "phase-checklist:done,phase-steps:failed" && j2[0]!.note === "nothing to add" && j2[1]!.note.includes("without adding any steps"), j2.map((j) => [j.kind, j.state, j.note]))
  check("Retry: back to in progress, phase 2 still planning", (await resumeStory(id)).ok && (await status(id)) === "in-progress" && (await ph(p2.id)) === "planning")
  await stopStoryJobs(id, "test")
}

async function main() {
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
