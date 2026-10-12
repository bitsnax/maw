/**
 * Self-test for MAW's side of Machines (lib/pki-store, lib/agent-client,
 * lib/machines) against a REAL maw-agent. Uses MAW's database: it creates
 * MAW's certificate authority if it does not exist yet (that is its normal
 * first use), and a temporary machine named selftest-<time>, removed by
 * `cleanup`.
 *
 * Driven by machines-05.sh in three calls (run from /opt/maw):
 *   issue <out dir>  create the temporary machine; write its install values
 *   check <machine id> <test container name>
 *   cleanup          remove selftest machines and their action records
 */

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { prisma } from "../lib/prisma"
import { getPki } from "../lib/pki-store"
import { decryptSecret } from "../lib/crypto"
import {
  createMachine, getMachineInfo, getMachineContainers, runContainerAction, getContainerLogs, checkMachineInput,
} from "../lib/machines"

let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`)
  if (!ok) failed++
}

async function issue(out: string) {
  const name = `selftest-${Date.now()}`
  const before = await prisma.pki.count()
  const r = await createMachine({ name, address: "maw-agent-test", port: 7017, runAs: "nobody" }, null)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  const row = await prisma.pki.findUniqueOrThrow({ where: { id: "maw" } })
  console.log(before === 0 ? "  created MAW's certificate authority (first use)" : "  using MAW's existing certificate authority")
  check("CA key stored encrypted", row.caKeyEnc.startsWith("v1:") && !row.caKeyEnc.includes("PRIVATE KEY"))
  check("CA key decrypts with MAW_ENCRYPTION_KEY", decryptSecret(row.caKeyEnc).includes("PRIVATE KEY"))
  const m = await prisma.machine.findUniqueOrThrow({ where: { id: r.machine.id } })
  check("machine stored with fingerprint, without its key", /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(m.certFingerprint))
  check("same CA on a second call", (await getPki()).ca.certPem === r.install.caPem)
  check("duplicate name refused", !(await createMachine({ name, address: "maw-agent-test", port: 7017, runAs: "nobody" }, null)).ok)
  check("invalid fields refused", Object.keys(checkMachineInput({ name: "Bad Name", address: "-x", port: 0, runAs: "Root!" })).length === 4)
  writeFileSync(join(out, "id"), r.install.machineId)
  writeFileSync(join(out, "agent.pem"), r.install.certPem)
  writeFileSync(join(out, "agent.key"), r.install.keyPem, { mode: 0o644 })
  writeFileSync(join(out, "ca.pem"), r.install.caPem)
}

async function checkAgent(id: string, testCtr: string) {
  const m = await prisma.machine.findUniqueOrThrow({ where: { id } })

  const info = await getMachineInfo(m)
  check("info through mutual TLS", info.ok, info.ok ? `${info.data.host.hostname}, Docker ${info.data.docker?.version}` : info.message)
  const after = await prisma.machine.findUniqueOrThrow({ where: { id } })
  check("last seen and agent version recorded", !!after.lastSeenAt && after.agentVersion === "0.1.0")

  const list = await getMachineContainers(m)
  check("containers listed", list.ok && list.data.containers.some((c) => c.name === "maw-web"),
    list.ok ? `${list.data.containers.length} containers` : list.message)

  const restart = await runContainerAction(m, null, testCtr, "restart")
  check(`restart ${testCtr}`, restart.ok && restart.data.state === "running", restart.ok ? undefined : restart.message)
  const self = await runContainerAction(m, null, "maw-agent-test", "stop")
  check("agent refuses to stop itself", !self.ok && self.status === 409, self.ok ? "it stopped" : self.message)
  const actions = await prisma.machineAction.findMany({ where: { machineId: id }, orderBy: { createdAt: "asc" } })
  check("actions recorded (add, restart ok, stop refused)",
    actions.map((a) => `${a.action}:${a.ok}`).join(" ") === "machine.add:true container.restart:true container.stop:false",
    actions.map((a) => `${a.action}:${a.ok}`).join(" "))

  const logs = await getContainerLogs(m, testCtr, 5)
  check("logs read", logs.ok && logs.data.lines.length > 0, logs.ok ? `${logs.data.lines.length} lines` : logs.message)

  const wrongPin = await getMachineInfo({ ...m, certFingerprint: "00:" + m.certFingerprint.slice(3) })
  check("an agent with another fingerprint is refused", !wrongPin.ok && wrongPin.message.includes("not the one paired"),
    wrongPin.ok ? "accepted" : wrongPin.message)
  const noAgent = await getMachineInfo({ ...m, port: 1 })
  check("nothing listening: readable message", !noAgent.ok && noAgent.message.includes("Nothing is listening"),
    noAgent.ok ? "accepted" : noAgent.message)
  const badName = await getMachineInfo({ ...m, address: "maw-no-such-host" })
  check("unknown host name: readable message", !badName.ok && badName.message.includes("does not resolve"),
    badName.ok ? "accepted" : badName.message)
}

async function cleanup() {
  const machines = await prisma.machine.findMany({ where: { name: { startsWith: "selftest-" } }, select: { id: true } })
  await prisma.machineAction.deleteMany({ where: { machineName: { startsWith: "selftest-" } } })
  await prisma.machine.deleteMany({ where: { name: { startsWith: "selftest-" } } })
  console.log(`  removed ${machines.length} selftest machine(s) and their action records`)
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === "issue" && a) await issue(a)
  else if (cmd === "check" && a && b) await checkAgent(a, b)
  else if (cmd === "cleanup") await cleanup()
  else throw new Error("usage: machines-selftest.ts issue <dir> | check <id> <container> | cleanup")
  if (cmd !== "cleanup") console.log(failed === 0 ? "PASS" : `FAIL (${failed})`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
