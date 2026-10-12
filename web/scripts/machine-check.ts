/**
 * Checks a REAL paired machine through MAW's own code (lib/machines), as
 * the Console would: agent version and host commands, files, search, and
 * commands with live output, Stop and the action record. Used by
 * phase2-07.sh for snax02 after its agent update; safe to run again.
 *
 * The commands it runs are harmless (git status, npm/node --version, sleep)
 * and are recorded under the machine's Recent actions like any other
 * (Who: "—"). Nothing is written to the machine's files.
 *
 *   docker compose run --rm --no-deps migrate \
 *     npx tsx scripts/machine-check.ts info  <machine name>
 *   docker compose run --rm --no-deps migrate \
 *     npx tsx scripts/machine-check.ts check <machine name> <project root> <search text>
 *
 * info prints "address=<address>", "version=<agent version or ->", and
 * "online=yes|no", one per line, for the calling script.
 */

import { prisma } from "../lib/prisma"
import { AGENT_VERSION } from "../lib/install-file"
import {
  getMachineInfo, agentUpdate, listMachineDir, readMachineFile, searchMachineFiles,
  startMachineCommand, stopMachineCommand, streamMachineCommand, reconcileCommandRecords,
} from "../lib/machines"

let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  const d = detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok && typeof detail === "string" ? ` (${detail})` : ok ? "" : d}`)
  if (!ok) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Ev = { type: string; text?: string; stream?: string; login?: boolean; state?: string; exitCode?: number | null; message?: string }

async function machineByName(name: string) {
  const m = await prisma.machine.findUnique({ where: { name } })
  if (!m) throw new Error(`No machine named ${name} in MAW.`)
  return m
}

/** Runs a command and reads its whole stream, as the Console does. */
async function run(m: Awaited<ReturnType<typeof machineByName>>, root: string, command: string) {
  const s = await startMachineCommand(m, null, root, command, 60)
  if (!s.ok) return { ok: false as const, message: s.message }
  const st = await streamMachineCommand(m, s.data.jobId)
  if (!st.ok) return { ok: false as const, message: st.message }
  const text = await new Response(st.data).text()
  const ev = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Ev)
  const out = ev.filter((e) => e.type === "line" && !e.login).map((e) => e.text ?? "")
  const end = ev.at(-1)
  return { ok: true as const, jobId: s.data.jobId, out, end, login: ev.filter((e) => e.login).length }
}

async function info(name: string) {
  const m = await machineByName(name)
  const r = await getMachineInfo(m)
  console.log(`address=${m.address}`)
  console.log(`version=${r.ok ? r.data.agent.version : m.agentVersion ?? "-"}`)
  console.log(`online=${r.ok ? "yes" : "no"}`)
  if (!r.ok) console.log(`message=${r.message}`)
}

async function checkAll(name: string, root: string, needle: string) {
  const m = await machineByName(name)
  console.log(`agent on ${name} (${m.address}:${m.port})`)
  const info = await getMachineInfo(m)
  check("online through mutual TLS", info.ok, info.ok ? undefined : info.message)
  if (!info.ok) return
  const a = info.data.agent
  check(`agent ${AGENT_VERSION}`, a.version === AGENT_VERSION, a.version)
  check("no update notice any more", agentUpdate(m, a.version) === null)
  check("host user read", a.hostUser?.ok === true,
    a.hostUser?.ok ? `${a.hostUser.user}, uid ${a.hostUser.uid}, LANG ${a.hostUser.lang}` : a.hostUser)
  check("host commands work", a.commands?.ok === true, a.commands?.ok ? `${a.commands.ms} ms` : a.commands)
  check("ripgrep in the image", !!a.ripgrep, a.ripgrep ?? undefined)

  console.log(`files and search in ${root}`)
  const l = await listMachineDir(m, root)
  check(`${root} lists`, l.ok && l.data.entries.length > 0, l.ok ? `${l.data.entries.length} entries` : l.message)
  const file = l.ok ? (l.data.entries.find((e) => e.name === "package.json") ?? l.data.entries.find((e) => e.type === "file")) : undefined
  if (file) {
    const r = await readMachineFile(m, root, file.name, 0, 5)
    check(`a file opens (${file.name})`, r.ok && r.data.content.startsWith("00001| "), r.ok ? `${r.data.totalLines} lines` : r.message)
  } else check("a file to open in the root", false, "no file at the top of the root")
  const s = await searchMachineFiles(m, root, needle, { ignoreCase: true })
  check(`search "${needle}" finds matches`, s.ok && s.data.matches.length > 0,
    s.ok ? `${s.data.matches.length}${s.data.truncated ? "+" : ""} matches, e.g. ${s.data.matches[0]?.file}:${s.data.matches[0]?.line}` : s.message)
  check("search skips node_modules", s.ok && !s.data.matches.some((x) => x.file.startsWith("node_modules/")))

  console.log("commands (login shell, live output)")
  const g = await run(m, root, `git -C ${root} status --short --branch`)
  check(`git -C ${root} status`, g.ok && g.end?.type === "end" && g.end.exitCode === 0 && g.out.some((x) => x.startsWith("## ")),
    g.ok ? g.out[0] ?? "" : g.message)
  if (g.ok && g.login) console.log(`       note: the login shell printed ${g.login} line(s) first (kept apart, as in the Console)`)
  const n = await run(m, root, "npm --version; node --version")
  check("npm --version and node --version (login PATH)", n.ok && n.end?.exitCode === 0 && /^\d+\.\d+/.test(n.out[0] ?? "") && /^v\d+/.test(n.out[1] ?? ""),
    n.ok ? `npm ${n.out[0]}, node ${n.out[1]}` : n.message)

  const mark = String(Date.now() % 100000).padStart(5, "0")
  const st = await startMachineCommand(m, null, root, `sleep 300.${mark}`, 600)
  if (st.ok) {
    await sleep(1500)
    const t0 = Date.now()
    const sp = await stopMachineCommand(m, st.data.jobId)
    check("sleep 300 + Stop: stopped", sp.ok && sp.data.state === "stopped", sp.ok ? `${Date.now() - t0} ms` : sp.message)
    // [3] keeps pgrep from matching its own command line.
    const left = await run(m, root, `pgrep -fa 'sleep 30[0].${mark}' || echo none`)
    check("nothing left running", left.ok && left.out.join() === "none", left.ok ? left.out : left.message)
  } else check("sleep 300 starts", false, st.message)

  await reconcileCommandRecords(m)
  const recent = await prisma.machineAction.findMany({
    where: { machineId: m.id, action: "command", createdAt: { gte: new Date(Date.now() - 5 * 60_000) } },
    orderBy: { createdAt: "asc" },
  })
  check("every command recorded with its outcome",
    recent.length >= 4 && recent.every((r) => !(r.message ?? "").startsWith("running · ")),
    recent.map((r) => `${r.target} → ${(r.message ?? "").replace(/ · job [0-9a-f]{16}$/, "")}`))
  for (const r of recent) console.log(`       ${r.target}  →  ${(r.message ?? "").replace(/ · job [0-9a-f]{16}$/, "")}`)
}

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2)
  if (cmd === "info" && a) await info(a)
  else if (cmd === "check" && a && b && c) await checkAll(a, b, c)
  else throw new Error("usage: machine-check.ts info <name> | check <name> <root> <search text>")
  if (cmd === "check") console.log(failed === 0 ? "PASS" : `FAIL (${failed})`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e instanceof Error ? e.message : e); await prisma.$disconnect(); process.exit(1) })
