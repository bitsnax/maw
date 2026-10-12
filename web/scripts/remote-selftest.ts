/**
 * Self-test for MAW's side of Phase 2 (lib/agent-client, lib/machines):
 * files, search, commands, the command stream, action records and the
 * update notice, against a REAL maw-agent 0.2.0. Uses MAW's database and a
 * temporary machine named selftest-<time>, removed by `cleanup`.
 *
 * Driven by phase2-05.sh (run from /opt/maw, in the migrate container):
 *   issue <out dir> <run-as user> [address] [port]
 *       create the temporary machine; write its id and install values
 *   check <machine id> <project root>
 *       everything below, through MAW's code; the root must be an empty
 *       folder inside /opt on the agent's machine
 *   cleanup
 *       remove selftest machines and their action records
 */

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { prisma } from "../lib/prisma"
import { installFile, AGENT_IMAGE, AGENT_VERSION } from "../lib/install-file"
import {
  createMachine, getMachineInfo, agentUpdate, versionBelow,
  readMachineFile, listMachineDir, writeMachineFile, editMachineFile, globMachineFiles, searchMachineFiles,
  startMachineCommand, getMachineCommand, stopMachineCommand, listMachineCommands, streamMachineCommand,
  reconcileCommandRecords,
} from "../lib/machines"

let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  const d = detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : d}`)
  if (!ok) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function issue(out: string, runAs: string, address = "maw-agent-test", port = 7017) {
  const name = `selftest-${Date.now()}`
  const r = await createMachine({ name, address, port, runAs }, null)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  writeFileSync(join(out, "id"), r.install.machineId)
  writeFileSync(join(out, "agent.pem"), r.install.certPem)
  writeFileSync(join(out, "agent.key"), r.install.keyPem, { mode: 0o644 })
  writeFileSync(join(out, "ca.pem"), r.install.caPem)
  console.log(`  temporary machine ${name} (runs as ${runAs})`)
}

type Event = { type: string; seq?: number; text?: string; stream?: string; login?: boolean; state?: string; exitCode?: number | null; message?: string }

/** Reads the whole stream MAW passes to the browser. */
async function readStream(s: ReadableStream<Uint8Array>): Promise<Event[]> {
  const text = await new Response(s).text()
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Event)
}
const shown = (ev: Event[]) => ev.filter((e) => e.type === "line" && !e.login).map((e) => `${e.stream}:${e.text}`)

async function record(machineId: string, action: string, contains: string) {
  return prisma.machineAction.findFirst({
    where: { machineId, action, OR: [{ target: { contains } }, { message: { contains } }] },
    orderBy: { createdAt: "desc" },
  })
}

async function checkAll(id: string, root: string) {
  const m = await prisma.machine.findUniqueOrThrow({ where: { id } })

  console.log("agent and version")
  let info = await getMachineInfo(m)
  for (let i = 0; i < 20 && info.ok && info.data.agent.commands?.error === "not checked yet"; i++) {
    await sleep(500)
    info = await getMachineInfo(m)
  }
  check("info through mutual TLS", info.ok, info.ok ? undefined : info.message)
  if (!info.ok) return
  check(`agent ${AGENT_VERSION}`, info.data.agent.version === AGENT_VERSION, info.data.agent.version)
  check("host user and command check reported", info.data.agent.hostUser?.ok === true && info.data.agent.commands?.ok === true, info.data.agent)
  check("no update offered for the current agent", agentUpdate(m, info.data.agent.version) === null)
  const up = agentUpdate(m, "0.1.0")
  check("update offered for 0.1.0, with the image and the compose change",
    !!up && up.steps.length === 2 && up.steps[0]!.command.startsWith(`docker save ${AGENT_IMAGE} | ssh `) &&
      up.steps[1]!.command.includes(`image: ${AGENT_IMAGE}`) && up.steps[1]!.command.includes("docker compose up -d"), up)
  check("version compare", versionBelow("0.1.9", "0.2.0") && !versionBelow("0.2.0", "0.2.0") && !versionBelow("0.10.0", "0.2.0"))
  const yaml = installFile({ name: "x", address: "192.168.4.250", port: 7017, runAs: "bitsnax" },
    { machineId: "x", certPem: "C", keyPem: "K", caPem: "A" })
  check(`install files use ${AGENT_IMAGE}`, yaml.includes(`image: ${AGENT_IMAGE}\n`))

  console.log("files and search")
  const w = await writeMachineFile(m, null, root, "src/hello.txt", "alpha\nNEEDLE beta\ngamma\n")
  check("write: new file", w.ok && w.data.created && w.data.bytes === 24, w.ok ? w.data : w.message)
  const wr = await record(id, "file.write", "src/hello.txt")
  check("write recorded (path, created, bytes)", !!wr && wr.ok && wr.target === `${root}/src/hello.txt` && wr.message === "created · 24 bytes", wr)
  const r = await readMachineFile(m, root, "src/hello.txt")
  check("read: numbered lines", r.ok && r.data.content === "00001| alpha\n00002| NEEDLE beta\n00003| gamma" && r.data.totalLines === 3, r.ok ? r.data : r.message)
  const l = await listMachineDir(m, root)
  check("list: the new folder", l.ok && l.data.entries.some((e) => e.name === "src" && e.type === "dir"), l.ok ? l.data : l.message)
  const e = await editMachineFile(m, null, root, "src/hello.txt", "gamma", "delta")
  check("edit: one replacement", e.ok && e.data.replacements === 1, e.ok ? e.data : e.message)
  const er = await record(id, "file.edit", "src/hello.txt")
  check("edit recorded", !!er && er.ok && er.message === "1 replacement", er)
  const bad = await editMachineFile(m, null, root, "src/hello.txt", "not there", "x")
  const br = await prisma.machineAction.findFirst({ where: { machineId: id, action: "file.edit", ok: false } })
  check("edit refused (not found): 422, recorded as failed", !bad.ok && bad.status === 422 && !!br, bad.ok ? "accepted" : `${bad.status} ${bad.message}`)
  const g = await globMachineFiles(m, root, "*.txt")
  check("glob", g.ok && g.data.files.join() === "src/hello.txt", g.ok ? g.data : g.message)
  const s = await searchMachineFiles(m, root, "needle", { ignoreCase: true })
  check("search", s.ok && s.data.matches.length === 1 && s.data.matches[0]!.line === 2, s.ok ? s.data : s.message)
  const reads = await prisma.machineAction.count({ where: { machineId: id, action: { in: ["file.read", "file.list", "file.glob", "file.search"] } } })
  check("reads, lists and searches are not recorded", reads === 0, reads)
  const out = await listMachineDir(m, "/etc")
  check("root outside /opt: refused with the agent's message", !out.ok && out.status === 400 && /outside/.test(out.message), out.ok ? "accepted" : out.message)

  console.log("commands and the stream")
  const c1 = await startMachineCommand(m, null, root, "echo hello; sleep 1; echo oops >&2; exit 3")
  check("start", c1.ok && /^[0-9a-f]{16}$/.test(c1.data.jobId), c1.ok ? undefined : c1.message)
  if (!c1.ok) return
  const rec1 = await record(id, "command", `job ${c1.data.jobId}`)
  check("recorded while running (command, root)", !!rec1 && rec1.target === "echo hello; sleep 1; echo oops >&2; exit 3" &&
    rec1.message === `running · ${root} · job ${c1.data.jobId}`, rec1)
  const st = await streamMachineCommand(m, c1.data.jobId)
  check("stream opens", st.ok, st.ok ? undefined : st.message)
  if (st.ok) {
    const ev = await readStream(st.data)
    check("stream: output lines, stdout and stderr", JSON.stringify(shown(ev)) === JSON.stringify(["stdout:hello", "stderr:oops"]), shown(ev))
    const end = ev.at(-1)!
    check("stream: ends with the exit", end.type === "end" && end.state === "exited" && end.exitCode === 3, end)
  }
  await sleep(200)
  const done1 = await prisma.machineAction.findUniqueOrThrow({ where: { id: rec1!.id } })
  check("record completed by the stream: exit 3, failed", !done1.ok && /^exit 3 in \d+\.\d s · /.test(done1.message ?? ""), done1.message)
  const g0 = await getMachineCommand(m, c1.data.jobId)
  const helloSeq = g0.ok ? g0.data.lines.find((x) => x.text === "hello")?.seq ?? 0 : 0
  const again = await streamMachineCommand(m, c1.data.jobId, helloSeq)
  if (again.ok) {
    const ev = await readStream(again.data)
    check("stream ?after resumes after a line", shown(ev).join() === "stderr:oops" && ev.at(-1)!.type === "end", shown(ev))
  } else check("stream ?after resumes after a line", false, again.message)
  const g1 = await getMachineCommand(m, c1.data.jobId)
  check("status: lines and exit code", g1.ok && g1.data.exitCode === 3 && g1.data.lines.length >= 2, g1.ok ? g1.data : g1.message)

  const c2 = await startMachineCommand(m, null, root, "sleep 300")
  if (c2.ok) {
    await sleep(500)
    const sp = await stopMachineCommand(m, c2.data.jobId)
    check("Stop: stopped", sp.ok && sp.data.state === "stopped", sp.ok ? sp.data : sp.message)
    const r2 = await record(id, "command", `job ${c2.data.jobId}`)
    check("record completed by Stop", !!r2 && r2.ok && /^stopped after /.test(r2.message ?? ""), r2?.message)
  } else check("start sleep 300", false, c2.message)

  const c3 = await startMachineCommand(m, null, root, "sleep 30", 2)
  if (c3.ok) {
    let s3 = await getMachineCommand(m, c3.data.jobId)
    for (let i = 0; i < 30 && s3.ok && s3.data.state === "running"; i++) { await sleep(250); s3 = await getMachineCommand(m, c3.data.jobId) }
    check("2 s limit: timed out", s3.ok && s3.data.state === "timed_out", s3.ok ? s3.data.state : s3.message)
    const r3 = await record(id, "command", `job ${c3.data.jobId}`)
    check("record completed by a status call: timed out, failed", !!r3 && !r3.ok && !!r3.message?.startsWith("timed out after 2 s"), r3?.message)
  } else check("start sleep 30", false, c3.message)

  const c4 = await startMachineCommand(m, null, root, "sleep 1; echo unwatched")
  if (c4.ok) {
    await sleep(2500)
    const n = await reconcileCommandRecords(m)
    const r4 = await record(id, "command", `job ${c4.data.jobId}`)
    check("unwatched command: completed by reconcile (machine page)", n >= 1 && !!r4 && r4.ok && !!r4.message?.startsWith("exit 0 in "), { n, msg: r4?.message })
  } else check("start unwatched", false, c4.message)

  const c5 = await startMachineCommand(m, null, root, "sleep 2; echo late")
  if (c5.ok) {
    const t5 = Date.now()
    const s5 = await streamMachineCommand(m, c5.data.jobId)
    check("stream opens at once for a quiet command (no output yet)", s5.ok && Date.now() - t5 < 1000, `${Date.now() - t5} ms`)
    if (s5.ok) {
      const reader = s5.data.getReader()
      await reader.cancel()
      await sleep(300)
      const still = await getMachineCommand(m, c5.data.jobId)
      check("browser leaves the stream: the command keeps running", still.ok && still.data.state === "running", still.ok ? still.data.state : still.message)
      await stopMachineCommand(m, c5.data.jobId)
    } else check("stream c5", false, s5.message)
  }

  const fails = await startMachineCommand(m, null, "/etc", "true")
  const rf = await prisma.machineAction.findFirst({ where: { machineId: id, action: "command", target: "true" } })
  check("start refused (root outside /opt): readable, recorded as failed", !fails.ok && fails.status === 400 && !!rf && !rf.ok, fails.ok ? "accepted" : fails.message)
  const missing = await streamMachineCommand(m, "0123456789abcdef")
  check("stream of an unknown command: 404 with the agent's message", !missing.ok && missing.status === 404, missing.ok ? "opened" : `${missing.status} ${missing.message}`)
  const notId = await getMachineCommand(m, "../../v1/info")
  check("a job id that is not one is refused before the agent", !notId.ok && notId.status === 400)
  const wrongPin = await streamMachineCommand({ ...m, certFingerprint: "00:" + m.certFingerprint.slice(3) }, c1.data.jobId)
  check("stream: an agent with another fingerprint is refused", !wrongPin.ok && wrongPin.message.includes("not the one paired"), wrongPin.ok ? "opened" : wrongPin.message)
  const list = await listMachineCommands(m)
  check("list commands", list.ok && list.data.jobs.length >= 5, list.ok ? list.data.jobs.length : list.message)
  const open = await prisma.machineAction.count({ where: { machineId: id, action: "command", message: { startsWith: "running · " } } })
  check("no command record left saying running", open === 0, open)
}

async function cleanup() {
  const machines = await prisma.machine.findMany({ where: { name: { startsWith: "selftest-" } }, select: { id: true } })
  await prisma.machineAction.deleteMany({ where: { machineName: { startsWith: "selftest-" } } })
  await prisma.machine.deleteMany({ where: { name: { startsWith: "selftest-" } } })
  console.log(`  removed ${machines.length} selftest machine(s) and their action records`)
}

async function main() {
  const [cmd, a, b, c, d] = process.argv.slice(2)
  if (cmd === "issue" && a && b) await issue(a, b, c, d ? Number(d) : undefined)
  else if (cmd === "check" && a && b) await checkAll(a, b)
  else if (cmd === "cleanup") await cleanup()
  else throw new Error("usage: remote-selftest.ts issue <dir> <run-as> [address] [port] | check <id> <root> | cleanup")
  if (cmd === "check") console.log(failed === 0 ? "PASS" : `FAIL (${failed})`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
