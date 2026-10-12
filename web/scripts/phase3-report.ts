/**
 * Phase 3's "Done when" list, checked from what really happened in a
 * project: its MAW sessions (OpenCode's record of each tool call), the
 * machine's Recent actions, and `git diff --stat` on the machine.
 *
 *   docker compose run --rm --no-deps migrate \
 *     npx tsx scripts/phase3-report.ts <project name> [hours, default 6]
 *
 * Read-only, apart from the one `git diff --stat` it runs on the machine
 * (recorded under Recent actions with Who "—"). The Dashboard part of the
 * list is a click-test and is not checked here.
 */

import path from "node:path"
import { prisma } from "../lib/prisma"
import { workspacePath } from "../lib/workspace"
import { ocMessages, type OcPart } from "../lib/opencode"
import { getMachineCommand, reconcileCommandRecords, startMachineCommand } from "../lib/machines"

let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const one = (s: string, n = 100) => s.replace(/\s+/g, " ").trim().slice(0, n)

async function main() {
  const [name, hoursArg] = process.argv.slice(2)
  if (!name) throw new Error("usage: phase3-report.ts <project name> [hours]")
  const hours = Number(hoursArg ?? 6)
  const since = new Date(Date.now() - hours * 3_600_000)
  const project = await prisma.project.findUnique({
    where: { name },
    include: { machine: true, sessions: { orderBy: { createdAt: "asc" }, include: { user: { select: { name: true, email: true } } } } },
  })
  if (!project) throw new Error(`no project named ${name}`)
  const m = project.machine
  const rel = (p: string) => (p.startsWith("/") ? path.posix.relative(project.root, p) : p.replace(/^\.\//, ""))
  console.log(`Project ${project.name}: ${project.root} on ${m.name}; the last ${hours} h (since ${since.toISOString().slice(0, 16).replace("T", " ")} UTC)`)

  // ---- sessions: what the model did ------------------------------------------
  console.log("\nSessions")
  const tools: (OcPart & { session: string })[] = []
  const aborted: { session: string; tool?: string }[] = []
  for (const s of project.sessions) {
    const r = await ocMessages(workspacePath(project.slug), s.id)
    if (!r.ok) { console.log(`  ${s.title}: could not read (${r.message})`); continue }
    const recent = r.data.filter((x) => x.info.time.created >= since.getTime())
    if (!recent.length) continue
    const parts = recent.flatMap((x) => x.parts.filter((p) => p.type === "tool"))
    const prompts = recent.filter((x) => x.info.role === "user").length
    const count = new Map<string, number>()
    for (const p of parts) count.set(p.tool ?? "?", (count.get(p.tool ?? "?") ?? 0) + 1)
    console.log(`  "${s.title}" (${s.user?.name || s.user?.email || "—"}): ${prompts} prompt(s); tools ${[...count].map(([k, v]) => `${k}×${v}`).join(", ") || "none"}`)
    tools.push(...parts.map((p) => ({ ...p, session: s.title })))
    for (const x of recent) {
      if ((x.info.error as { name?: string } | undefined)?.name !== "MessageAbortedError") continue
      const t = x.parts.find((p) => p.type === "tool" && p.state?.status === "error")
      aborted.push({ session: s.title, tool: t ? `${t.tool}: ${one(String(t.state?.input?.command ?? t.state?.input?.filePath ?? ""))}` : undefined })
    }
  }
  const done = (t: string) => tools.filter((p) => p.tool === t && p.state?.status === "completed")
  const reads = done("read"), searches = [...done("glob"), ...done("grep")]
  check("it reads and searches the project", reads.length > 0 && searches.length > 0,
    `${reads.length} read(s), ${searches.length} search(es)${searches[0] ? `, e.g. ${searches[0].tool} ${one(String(searches[0].state?.input?.pattern ?? ""))}` : ""}`)
  const gs = done("bash").filter((p) => /\bgit status\b/.test(String(p.state?.input?.command ?? "")))
  check("it runs git status (output shown live in the session)", gs.length > 0 && !!gs[0]!.state?.output,
    gs[0] ? `"${one(String(gs[0].state?.input?.command))}" → ${one(gs[0].state?.output ?? "", 80)}` : "no completed git status call")
  const edits = [...done("edit"), ...done("write")]
  const edited = [...new Set(edits.map((p) => rel(String(p.state?.input?.filePath ?? ""))))]
  check("it edits a file", edits.length > 0, edited.join(", ") || "no completed edit or write")
  check("Abort stops a running turn", aborted.length > 0, aborted.map((a) => `"${a.session}"${a.tool ? ` during ${a.tool}` : ""}`).join("; ") || "no aborted turn")

  // ---- the machine: records and git diff ------------------------------------
  console.log(`\n${m.name}`)
  await reconcileCommandRecords(m).catch(() => 0)
  const acts = await prisma.machineAction.findMany({
    where: { machineId: m.id, createdAt: { gte: since }, action: { in: ["file.write", "file.edit", "command"] } },
    orderBy: { createdAt: "asc" }, include: { user: { select: { name: true, email: true } } },
  })
  const who = (a: (typeof acts)[number]) => a.user?.name || a.user?.email || "—"
  const fileActs = acts.filter((a) => a.action !== "command" && a.userId && a.target?.startsWith(project.root))
  check("Recent actions: the edits, with you as Who", fileActs.length > 0,
    [...new Set(fileActs.map((a) => `${a.action} ${rel(a.target!)} · ${who(a)}`))].slice(-5).join("; ") || "none with a user")
  const cmds = acts.filter((a) => a.action === "command" && a.userId)
  const gsRec = cmds.find((a) => /\bgit status\b/.test(a.target ?? ""))
  check("Recent actions: the commands, with you as Who", !!gsRec,
    gsRec ? `"${one(gsRec.target ?? "", 70)}" · ${who(gsRec)} · ${one(gsRec.message ?? "", 40)}` : "no git status command with a user")
  const stopped = cmds.find((a) => a.message?.startsWith("stopped"))
  check("Recent actions: the aborted command was stopped on the machine", !!stopped,
    stopped ? `"${one(stopped.target ?? "", 60)}" · ${one(stopped.message ?? "", 30)}` : "no stopped command with a user")

  const st = await startMachineCommand(m, null, project.root, "git diff --stat", 60)
  if (!st.ok) { check("git diff --stat on the machine", false, st.message); return }
  let d = await getMachineCommand(m, st.data.jobId)
  for (let i = 0; i < 60 && d.ok && d.data.state === "running"; i++) { await sleep(500); d = await getMachineCommand(m, st.data.jobId) }
  const lines = d.ok ? d.data.lines.filter((l) => !l.login).map((l) => l.text) : []
  console.log("  git diff --stat:")
  for (const l of lines.length ? lines : ["(no changes)"]) console.log(`    ${l}`)
  const shown = edited.filter((f) => lines.some((l) => l.trim().startsWith(f)))
  check("the edit shows in git diff on the machine", shown.length > 0,
    shown.length ? shown.join(", ") : edited.length ? `none of ${edited.join(", ")} (reverted already, or untracked)` : "no edited file")
}

main()
  .then(async () => {
    console.log(failed === 0 ? "\nPASS (the Dashboard is checked by the click-test)" : `\nFAIL (${failed})`)
    await prisma.$disconnect()
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch(async (e) => { console.error(e instanceof Error ? e.message : e); await prisma.$disconnect(); process.exit(1) })
