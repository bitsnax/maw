/**
 * Self-test for maw-opencode through MAW's own code (lib/sessions,
 * lib/opencode, lib/workspace): a session in a project's workspace, a prompt,
 * and the six tools reaching the project's machine through MAW's tool API.
 *
 * Driven by phase3-03.sh (run from /opt/maw, in the migrate container):
 *   mock <machine id> <root>
 *       against a test OpenCode whose model is opencode/test/mock-llm.mjs:
 *       write → read → edit → glob → grep → bash, then an aborted `sleep 30`.
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
import { ocAbort, ocHealth, ocMessages, ocPrompt, ocStatus, type OcMessage, type OcPart } from "../lib/opencode"
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
  } finally {
    const r = await removeProject(p.project.id, null)
    check("project removed (its OpenCode session deleted too)", r.ok)
  }
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
