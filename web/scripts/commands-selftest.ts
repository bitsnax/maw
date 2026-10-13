/**
 * Self-test for project command buttons (lib/project-commands): checks,
 * placeholders, add / edit / reorder / remove, and a real run on a machine
 * with a value full of quotes, which must arrive as one literal word.
 *
 *   docker compose run --rm --no-deps migrate \
 *     npx tsx scripts/commands-selftest.ts check <machine id> <root>
 *
 * Uses a temporary project (selftest-cmd-*), removed at the end.
 */

import { prisma } from "../lib/prisma"
import { createProject, removeProject } from "../lib/projects"
import { getMachineCommand, startMachineCommand } from "../lib/machines"
import {
  addCommand, checkCommandInput, fillCommand, listCommands, moveCommand, placeholders, removeCommand, updateCommand,
} from "../lib/project-commands"

let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  const d = detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : d}`)
  if (!ok) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function pure() {
  console.log("checks and placeholders")
  check("empty title and command refused", Object.keys(checkCommandInput({ title: " ", command: "" })).join() === "title,command")
  check("a 41-character title refused", !!checkCommandInput({ title: "x".repeat(41), command: "ls" }).title)
  check("placeholders found once each, in order", placeholders('git commit -m "{message}" && echo {branch} {message}').join() === "message,branch")
  check("{1x} and { a } are not placeholders", placeholders("echo {1x} { a } {}").length === 0)
  const miss = fillCommand("git checkout -b {branch}", { branch: "  " })
  check("an empty value is reported, not run", !miss.ok && miss.missing.join() === "branch")
  const f = fillCommand('git commit -m "{message}"', { message: `it's "done" $HOME` })
  check("quotes around a placeholder dropped; value single-quoted",
    f.ok && f.command === `git commit -m 'it'\\''s "done" $HOME'`, f)
  const g = fillCommand("git checkout -b {branch}", { branch: "maw/story-1" })
  check("no placeholders left after filling", g.ok && g.command === "git checkout -b 'maw/story-1'", g)
}

async function run(m: { id: string }, root: string, command: string) {
  const machine = await prisma.machine.findUniqueOrThrow({ where: { id: m.id } })
  const s = await startMachineCommand(machine, null, root, command, 60)
  if (!s.ok) return { ok: false as const, message: s.message }
  for (let i = 0; i < 60; i++) {
    const d = await getMachineCommand(machine, s.data.jobId)
    if (d.ok && d.data.state !== "running") return { ok: true as const, state: d.data.state, exit: d.data.exitCode, out: d.data.lines.filter((l) => !l.login).map((l) => l.text) }
    await sleep(500)
  }
  return { ok: false as const, message: "did not finish in 30 s" }
}

async function checkAll(machineId: string, root: string) {
  pure()
  const tag = `selftest-cmd-${Date.now() % 100000}`
  const p = await createProject({ name: tag, machineId, root }, null)
  if (!p.ok) { check("project for the test", false, p); return }
  try {
    console.log("add, edit, reorder, remove")
    const a = await addCommand(p.project.id, null, { title: "Status", command: "git status" })
    const b = await addCommand(p.project.id, null, { title: "Say", command: 'printf "%s\\n" "{message}"' })
    const c = await addCommand(p.project.id, null, { title: "Where", command: "pwd" })
    check("three buttons added", a.ok && b.ok && c.ok)
    if (!a.ok || !b.ok || !c.ok) return
    check("listed in the order added", (await listCommands(p.project.id)).map((x) => x.title).join() === "Status,Say,Where")
    await moveCommand(c.command.id, -1)
    check("Where moved left", (await listCommands(p.project.id)).map((x) => x.title).join() === "Status,Where,Say")
    await moveCommand(a.command.id, -1)
    check("the first cannot move further left", (await listCommands(p.project.id)).map((x) => x.title).join() === "Status,Where,Say")
    const u = await updateCommand(a.command.id, { title: "Git status", command: "git status --short" })
    check("edited", u.ok && (await listCommands(p.project.id))[0]!.title === "Git status")
    const bad = await updateCommand(a.command.id, { title: "", command: "x" })
    check("an edit with an empty title refused", !bad.ok && "title" in bad.errors)
    await removeCommand(a.command.id)
    check("removed", (await listCommands(p.project.id)).map((x) => x.title).join() === "Where,Say")

    console.log("run on the machine")
    const where = await run({ id: machineId }, root, "pwd")
    check("a button runs in the project folder", where.ok && where.exit === 0 && where.out.join() === root, where)
    const value = `it's "done" $HOME \`id\``
    const filled = fillCommand(b.command.command, { message: value })
    const say = filled.ok ? await run({ id: machineId }, root, filled.command) : { ok: false as const, message: "fill failed" }
    check("a value with quotes, $ and backquotes arrives as one literal word", say.ok && say.out.join("\n") === value, say)
    const rec = await prisma.machineAction.findFirst({ where: { machineId, action: "command", target: filled.ok ? filled.command : "" }, orderBy: { createdAt: "desc" } })
    check("the run is recorded under Recent actions", !!rec, rec)
  } finally {
    const r = await removeProject(p.project.id, null)
    check("project removed (its buttons with it)", r.ok && (await prisma.projectCommand.count({ where: { projectId: p.project.id } })) === 0)
  }
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === "check" && a && b) await checkAll(a, b)
  else throw new Error("usage: commands-selftest.ts check <machine id> <root>")
  console.log(failed === 0 ? "PASS" : `FAIL (${failed})`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
