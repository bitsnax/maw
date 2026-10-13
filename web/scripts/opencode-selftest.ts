/**
 * Self-test for maw-opencode through MAW's own code (lib/sessions,
 * lib/opencode, lib/workspace): a session in a project's workspace, a prompt,
 * and the six tools reaching the project's machine through MAW's tool API.
 *
 * Driven by phase3-03.sh (run from /opt/maw, in the migrate container):
 *   mock <machine id> <root>
 *       against a test OpenCode whose model is opencode/test/mock-llm.mjs:
 *       write → read → edit → glob → grep → bash, then an aborted `sleep 30`,
 *       then (step 04) the session page's live view: streamed text and a
 *       question answered, as the browser gets them (lib/session-events).
 *       Uses a temporary project (selftest-*), removed at the end.
 *   real <project name>
 *       one read-only prompt to the real 27B in that project (caw on snax02);
 *       the session is kept, so it shows on the project page.
 * Environment: MAW_OPENCODE_URL, MAW_OPENCODE_PASSWORD, MAW_WORKSPACES_DIR.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { prisma } from "../lib/prisma"
import { createProject, removeProject } from "../lib/projects"
import { startSession } from "../lib/sessions"
import { ocAbort, ocHealth, ocMessages, ocPrompt, ocQuestionReply, ocStatus, type OcMessage, type OcPart } from "../lib/opencode"
import { sessionEventStream } from "../lib/session-events"
import { liveStates } from "../lib/session-status"
import { createStory } from "../lib/stories"
import { listMachineCommands, readMachineFile } from "../lib/machines"

let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  const d = detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 700)}`
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : d}`)
  if (!ok) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits until the session has been busy and is idle again (or the limit). */
async function waitIdle(directory: string, id: string, limitMs: number): Promise<{ idle: boolean; ms: number }> {
  const t0 = Date.now()
  let busy = false
  while (Date.now() - t0 < limitMs) {
    await sleep(500)
    const s = await ocStatus(directory)
    const st = s.ok ? s.data[id]?.type : undefined
    if (st === "busy" || st === "retry") busy = true
    else if (busy || Date.now() - t0 > 8000) return { idle: true, ms: Date.now() - t0 }
  }
  return { idle: false, ms: Date.now() - t0 }
}

const toolParts = (ms: OcMessage[]) => ms.flatMap((m) => m.parts).filter((p) => p.type === "tool")
const lastText = (ms: OcMessage[]) => ms.filter((m) => m.info.role === "assistant").flatMap((m) => m.parts).filter((p) => p.type === "text").map((p) => p.text ?? "").at(-1) ?? ""
const out = (p: OcPart | undefined) => p?.state?.output ?? p?.state?.error ?? ""

function transcript(ms: OcMessage[]) {
  for (const m of ms) {
    for (const p of m.parts) {
      if (p.type === "text" && p.text?.trim()) console.log(`       ${m.info.role}: ${p.text.trim().slice(0, 400).replace(/\n/g, "\n         ")}`)
      else if (p.type === "tool") console.log(`       tool ${p.tool} [${p.state?.status}] ${JSON.stringify(p.state?.input ?? {}).slice(0, 120)}\n         → ${out(p).slice(0, 240).replace(/\n/g, "\n           ")}`)
      else if (p.type === "reasoning") console.log(`       (thinking: ${(p.text ?? "").length} characters)`)
    }
  }
}

async function mock(machineId: string, root: string) {
  const h = await ocHealth()
  check("maw-opencode answers (password accepted)", h.ok && h.data.healthy, h.ok ? undefined : h.message)
  if (!h.ok) return
  check("OpenCode 1.19.0", h.data.version === "1.19.0", h.data.version)

  const tag = `selftest-${Date.now() % 100000}`
  const p = await createProject({ name: tag, machineId, root }, null)
  if (!p.ok) { check("project for the test", false, p); return }
  const user = await prisma.user.findFirst({ select: { id: true } })
  try {
    const s = await startSession(p.project.id, user?.id ?? null, "mock check")
    check("session started (workspace, OpenCode session, MAW row)", s.ok, s.ok ? undefined : s.message)
    if (!s.ok) return
    const local = path.join(process.env.MAW_WORKSPACES_DIR || "/workspaces", p.project.slug, "AGENTS.md")
    const agents = readFileSync(local, "utf8")
    check("workspace AGENTS.md says where the project lives", agents.includes(`in \`${root}\``) && agents.includes("only a stand-in"), agents.slice(0, 200))
    check("session recorded in MAW", !!(await prisma.projectSession.findUnique({ where: { id: s.session.id } })))

    const pr = await ocPrompt(s.session.directory, s.session.id, "go")
    check("prompt sent", pr.ok, pr.ok ? undefined : pr.message)
    const w = await waitIdle(s.session.directory, s.session.id, 120_000)
    check("the turn finished", w.idle, `${w.ms} ms`)
    const ms = await ocMessages(s.session.directory, s.session.id)
    if (!ms.ok) { check("messages", false, ms.message); return }
    const tools = toolParts(ms.data)
    check("all six tools ran, in order", tools.map((t) => t.tool).join() === "write,read,edit,glob,grep,bash", tools.map((t) => `${t.tool}:${t.state?.status}`))
    const by = (n: string) => tools.find((t) => t.tool === n)
    check("every tool completed", tools.length === 6 && tools.every((t) => t.state?.status === "completed"), tools.map((t) => `${t.tool}:${t.state?.status}:${out(t).slice(0, 120)}`))
    check("write: OpenCode's answer", out(by("write")) === "Wrote file successfully.", out(by("write")))
    check("read: the file as written, numbered", out(by("read")).includes(`<path>${root}/notes/hello.txt</path>`) && out(by("read")).includes("1: hello from the tools"), out(by("read")))
    check("edit: applied", out(by("edit")) === "Edit applied successfully.", out(by("edit")))
    check("glob: the file, by its path on the machine", out(by("glob")).includes(`${root}/notes/hello.txt`), out(by("glob")))
    check("grep: found", out(by("grep")).startsWith("Found 1 matches") && out(by("grep")).includes("Line 1: HELLO from the tools"), out(by("grep")))
    check("bash: ran on the machine, in the project folder", out(by("bash")) === `HELLO from the tools\n${root}`, out(by("bash")))
    check("bash: exit code and live output in its metadata", by("bash")?.state?.metadata?.exit === 0 && typeof by("bash")?.state?.metadata?.output === "string", by("bash")?.state?.metadata)
    check("the model's answer", lastText(ms.data).includes("all six tools ran"), lastText(ms.data))
    const m = await prisma.machine.findUniqueOrThrow({ where: { id: machineId } })
    const f = await readMachineFile(m, root, "notes/hello.txt")
    check("the file on the machine has the edit", f.ok && f.data.content === "00001| HELLO from the tools", f.ok ? f.data.content : f.message)
    const acts = await prisma.machineAction.findMany({ where: { machineId, createdAt: { gte: new Date(Date.now() - 5 * 60_000) } } })
    check("write, edit and command recorded with the session's user",
      ["file.write", "file.edit", "command"].every((a) => acts.some((x) => x.action === a && x.userId === (user?.id ?? null))),
      acts.map((a) => `${a.action}:${a.userId ? "user" : "-"}`))

    console.log("abort")
    const pr2 = await ocPrompt(s.session.directory, s.session.id, "sleep please")
    check("second prompt sent", pr2.ok)
    let running = false
    for (let i = 0; i < 40 && !running; i++) {
      await sleep(500)
      const m2 = await ocMessages(s.session.directory, s.session.id)
      running = m2.ok && toolParts(m2.data).some((t) => t.state?.input?.command === "sleep 30" && t.state?.status === "running")
    }
    check("bash `sleep 30` is running on the machine", running)
    const ls = await liveStates([p.project.id])
    const l = ls.states.get(s.session.id)
    check("Dashboard: working, on Command: sleep 30", l?.state === "working" && l.activity === "Command: sleep 30" && !!l.since, l ?? ls.unreachable)
    await sleep(1000)
    const ab = await ocAbort(s.session.directory, s.session.id)
    check("Abort accepted", ab.ok, ab.ok ? undefined : ab.message)
    let state = "running"
    for (let i = 0; i < 40 && state === "running"; i++) {
      await sleep(250)
      const l = await listMachineCommands(m)
      state = l.ok ? (l.data.jobs.find((j) => j.command === "sleep 30")?.state ?? "gone") : "?"
    }
    check("the command was stopped on the machine", state === "stopped", state)
    const w2 = await waitIdle(s.session.directory, s.session.id, 20_000)
    check("the session is idle again", w2.idle)
    check("Dashboard: idle sessions are left out", !(await liveStates([p.project.id])).states.has(s.session.id))

    console.log("live view (the session page's events)")
    await liveView(s.session.directory, s.session.id, p.project.id)

    console.log("story tools through OpenCode")
    await storyTools(p.project.id, s.session.directory, s.session.id)
  } finally {
    const r = await removeProject(p.project.id, null)
    check("project removed (its OpenCode session deleted too)", r.ok)
  }
}

/** Follows the session's NDJSON events (as /api/sessions/<id>/events sends
 *  them) while the mock streams a slow answer and asks a question. */
async function liveView(directory: string, id: string, projectId: string) {
  const ac = new AbortController()
  const st = await sessionEventStream(directory, id, ac.signal)
  check("event stream opened", st.ok, st.ok ? undefined : st.message)
  if (!st.ok) return
  const events: { type: string; properties?: Record<string, unknown> }[] = []
  const reader = st.stream.getReader()
  const dec = new TextDecoder()
  let buf = ""
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) { events.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1) }
      }
    } catch { /* aborted */ }
  })()
  const waitFor = async (pred: () => boolean, ms: number) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await sleep(100); return pred() }
  const since = (n: number) => events.slice(n)
  try {
    check("ready first", await waitFor(() => events.length > 0, 5000) && events[0]!.type === "ready", events[0])

    let n = events.length
    await ocPrompt(directory, id, "slow")
    const idleAgain = () => since(n).some((e) => e.type === "session.idle")
    await waitFor(idleAgain, 30_000)
    const ev = since(n)
    const deltas = ev.filter((e) => e.type === "message.part.delta").map((e) => String(e.properties?.delta ?? ""))
    check("busy, streamed text in pieces, then idle",
      ev.some((e) => e.type === "session.status" && (e.properties?.status as { type?: string })?.type === "busy") && deltas.length >= 2 && idleAgain(),
      { types: [...new Set(ev.map((e) => e.type))], deltas })
    check("the pieces make the answer", deltas.join("").includes("came slowly."), deltas.join(""))
    check("only this session's events", ev.every((e) => !e.properties?.sessionID || e.properties.sessionID === id))

    n = events.length
    await ocPrompt(directory, id, "ask")
    await waitFor(() => since(n).some((e) => e.type === "question.asked"), 20_000)
    const q = since(n).find((e) => e.type === "question.asked")?.properties as { id?: string; questions?: { options?: { label: string }[] }[] } | undefined
    check("question.asked with the two options", q?.questions?.[0]?.options?.map((o) => o.label).join() === "main,phase3-1", q)
    const lq = (await liveStates([projectId])).states.get(id)
    check("Dashboard: waiting for you while the question is open", lq?.state === "waiting", lq)
    if (q?.id) {
      const r = await ocQuestionReply(directory, q.id, [["phase3-1"]])
      check("answer accepted", r.ok, r.ok ? undefined : r.message)
      await waitFor(() => since(n).some((e) => e.type === "session.idle"), 20_000)
      check("question.replied", since(n).some((e) => e.type === "question.replied"))
      const ms = await ocMessages(directory, id)
      const t = ms.ok ? lastText(ms.data) : ""
      check("the model got the answer", t.includes("phase3-1"), t)
    }
  } finally {
    ac.abort()
    await Promise.race([pump, sleep(2000)])
  }
}

/** The story tools as the model calls them (mock cue "CALL <tool> <json>"),
 *  and bash refusing state-changing git in a story session. */
async function storyTools(projectId: string, directory: string, plainSession: string) {
  const st = await createStory(projectId, null, { title: "OpenCode tools", request: "Check the story tools through OpenCode." })
  if (!st.ok) { check("story for the test", false, st); return }
  const storyId = st.story.id
  const run = async (sessionId: string, prompt: string) => {
    const pr = await ocPrompt(directory, sessionId, prompt)
    if (!pr.ok) return { ok: false as const, message: pr.message }
    await waitIdle(directory, sessionId, 60_000)
    const ms = await ocMessages(directory, sessionId)
    return ms.ok ? { ok: true as const, tools: toolParts(ms.data) } : { ok: false as const, message: ms.message }
  }

  const c = await startSession(projectId, null, "story checklist")
  if (!c.ok) { check("session for the checklist", false, c.message); return }
  await prisma.storyJob.create({ data: { storyId, kind: "story-checklist", sessionId: c.session.id } })
  const r1 = await run(c.session.id, 'CALL item_add {"text":"Where is the connections page?"}\nCALL story_read {"part":"story"}')
  const ia = r1.ok ? r1.tools.find((t) => t.tool === "item_add") : undefined
  const sr = r1.ok ? r1.tools.find((t) => t.tool === "story_read") : undefined
  check("item_add through OpenCode: the item is in MAW", ia?.state?.status === "completed" && (await prisma.storyItem.count({ where: { storyId } })) === 1, ia?.state)
  check("story_read through OpenCode: the story with the new item", sr?.state?.status === "completed" && out(sr).includes("Where is the connections page?"), sr?.state)

  const phase = await prisma.storyPhase.create({ data: { storyId, number: 1, title: "Count", goal: "x" } })
  const step = await prisma.storyStep.create({ data: { phaseId: phase.id, number: 1, title: "Count function", changes: "1." } })
  const sj = await startSession(projectId, null, "step 1.1")
  if (!sj.ok) { check("session for the step", false, sj.message); return }
  await prisma.storyJob.create({ data: { storyId, kind: "step", phaseId: phase.id, stepId: step.id, sessionId: sj.session.id } })
  const r2 = await run(sj.session.id, 'CALL bash {"command":"git status --short && git commit -am wip","timeout":60000}\nCALL step_finish {"status":"done","summary":"nothing to change"}')
  const b = r2.ok ? r2.tools.find((t) => t.tool === "bash") : undefined
  check("bash in a story session: git commit refused, nothing run", b?.state?.status === "error" && out(b).includes("Refused: `git commit`"), b?.state)
  const done = await prisma.storyStep.findUniqueOrThrow({ where: { id: step.id } })
  check("step_finish through OpenCode: step verifying (MAW verifies next)", done.status === "verifying" && done.result.includes("nothing to change"), done)

  const r3 = await run(plainSession, 'CALL item_add {"text":"x"}\nCALL bash {"command":"git branch --show-current","timeout":60000}')
  const ni = r3.ok ? r3.tools.filter((t) => t.tool === "item_add").at(-1) : undefined
  const nb = r3.ok ? r3.tools.filter((t) => t.tool === "bash").at(-1) : undefined
  check("a plain session cannot use story tools", ni?.state?.status === "error" && out(ni).includes("not one"), ni?.state)
  check("…and its bash is not limited (git branch runs)", nb?.state?.status === "completed", nb?.state)
}

async function real(projectName: string) {
  const project = await prisma.project.findUnique({ where: { name: projectName } })
  if (!project) { check(`project ${projectName} exists`, false); return }
  const h = await ocHealth()
  check("maw-opencode answers", h.ok, h.ok ? `OpenCode ${h.data.version}` : h.message)
  if (!h.ok) return
  const user = await prisma.user.findFirst({ where: { role: "admin" }, select: { id: true } })
  const s = await startSession(project.id, user?.id ?? null, "Step 03 check")
  check("session started", s.ok, s.ok ? undefined : s.message)
  if (!s.ok) return
  console.log(`       workspace ${s.session.directory}; project AGENTS.md ${s.session.agentsMd ? "copied" : "not found"}`)
  const prompt = [
    "This is a short check of MAW's tools; change nothing.",
    "1. Use the read tool to read web/package.json and find its \"name\" field.",
    "2. Use the bash tool to run: git status --short --branch | head -3",
    "Then answer in two short lines: the name, and the branch.",
  ].join("\n")
  const t0 = Date.now()
  const pr = await ocPrompt(s.session.directory, s.session.id, prompt)
  check("prompt sent", pr.ok, pr.ok ? undefined : pr.message)
  const w = await waitIdle(s.session.directory, s.session.id, 420_000)
  check("the 27B finished", w.idle, `${Math.round((Date.now() - t0) / 1000)} s`)
  console.log(`       took ${Math.round((Date.now() - t0) / 1000)} s`)
  const ms = await ocMessages(s.session.directory, s.session.id)
  if (!ms.ok) { check("messages", false, ms.message); return }
  transcript(ms.data)
  const tools = toolParts(ms.data)
  check("it read a file in the project through MAW", tools.some((t) => t.tool === "read" && t.state?.status === "completed" && out(t).includes(`<path>${project.root}/`)))
  check("it ran a command on the machine through MAW", tools.some((t) => t.tool === "bash" && t.state?.status === "completed" && out(t).length > 0))
  check("it answered", lastText(ms.data).trim().length > 0)
  const err = ms.data.map((m) => m.info.error).find(Boolean)
  check("no session error", !err, err)
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === "mock" && a && b) await mock(a, b)
  else if (cmd === "real" && a) await real(a)
  else throw new Error("usage: opencode-selftest.ts mock <machine id> <root> | real <project name>")
  console.log(failed === 0 ? "PASS" : `FAIL (${failed})`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
