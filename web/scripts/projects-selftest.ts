/**
 * Self-test for Projects (lib/projects) against a REAL maw-agent. Uses MAW's
 * database: a temporary machine (made with remote-selftest.ts issue) and
 * projects named selftest-*, removed by `cleanup`.
 *
 * Driven by phase3-01.sh (run from /opt/maw, in the migrate container):
 *   check <machine id> <root>   root: an existing empty folder inside /opt
 *   cleanup                     remove selftest projects (machines: remote-selftest cleanup)
 */

import { prisma } from "../lib/prisma"
import { checkProjectInput, createProject, makeSlug, normalizeRoot, removeProject } from "../lib/projects"
import { removeMachine } from "../lib/machines"

let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  const d = detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : d}`)
  if (!ok) failed++
}

async function checkAll(machineId: string, root: string) {
  const m = await prisma.machine.findUniqueOrThrow({ where: { id: machineId } })
  const tag = `selftest-${Date.now() % 100000}`

  console.log("fields")
  check("root normalized", normalizeRoot(" /opt//caw/ ") === "/opt/caw" && normalizeRoot("/opt/caw/../caw") === "/opt/caw")
  check("bad fields refused", Object.keys(checkProjectInput({ name: " ", machineId: "", root: "opt/caw" })).length === 3)
  check("/opt itself refused", !!checkProjectInput({ name: "x", machineId: "m", root: "/opt" }).root)

  console.log("add")
  const r = await createProject({ name: tag, machineId: m.id, root: root + "/" }, null)
  check("added (trailing slash dropped)", r.ok, r.ok ? undefined : r)
  if (!r.ok) return
  const p = await prisma.project.findUniqueOrThrow({ where: { id: r.project.id } })
  check("stored: machine, root, slug", p.machineId === m.id && p.root === root && /^[a-z0-9-]+$/.test(p.slug), p)
  check("slug is <machine>-<folder>", p.slug.startsWith(m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")), p.slug)
  check("next slug for the same name gets a number", (await makeSlug(m.name, root)) === `${p.slug}-2`)
  const rec = await prisma.machineAction.findFirst({ where: { machineId: m.id, action: "project.add" } })
  check("add recorded on the machine", !!rec && rec.target === root && rec.message === `project ${tag}`, rec)

  console.log("refusals")
  const dupName = await createProject({ name: tag, machineId: m.id, root: "/opt/elsewhere" }, null)
  check("same name refused", !dupName.ok && !!dupName.errors.name, dupName)
  const dupRoot = await createProject({ name: `${tag}-b`, machineId: m.id, root }, null)
  check("same folder on the same machine refused", !dupRoot.ok && /already uses/.test(dupRoot.errors.root ?? ""), dupRoot)
  const missing = await createProject({ name: `${tag}-c`, machineId: m.id, root: `${root}-missing` }, null)
  check("a folder that does not exist: the agent's message", !missing.ok && /does not exist/.test(missing.errors.root ?? ""), missing)
  // /etc exists on every host, but the agent only sees /opt: MAW must say "outside", not "does not exist".
  const outside = await createProject({ name: `${tag}-d`, machineId: m.id, root: "/etc" + "/ssh" }, null)
  check("a folder outside the base: said plainly", !outside.ok && /is outside .*the only folder MAW can use/.test(outside.errors.root ?? ""), outside)
  const sibling = await createProject({ name: `${tag}-g`, machineId: m.id, root: root.split("/").slice(0, 2).join("/") + "x/y" }, null)
  check("a folder whose name only starts like the base: outside too", !sibling.ok && /is outside/.test(sibling.errors.root ?? ""), sibling)
  const offline = await createProject({ name: `${tag}-e`, machineId: m.id, root }, null)
  check("(same folder again still refused)", !offline.ok)
  const noMachine = await createProject({ name: `${tag}-f`, machineId: "nope", root }, null)
  check("unknown machine refused", !noMachine.ok && !!noMachine.errors.machineId, noMachine)

  console.log("machine removal guard")
  const rm = await removeMachine(m.id, null)
  check("a machine with projects cannot be removed", !rm.ok && rm.message.includes(tag), rm)
  check("…and it is still there", !!(await prisma.machine.findUnique({ where: { id: m.id } })))

  console.log("sessions and removal")
  await prisma.projectSession.create({ data: { id: `ses_${tag}`, projectId: p.id, title: "selftest", userId: null } })
  const del = await removeProject(p.id, null)
  check("project removed", del.ok && !(await prisma.project.findUnique({ where: { id: p.id } })), del)
  check("its session rows removed with it", (await prisma.projectSession.count({ where: { projectId: p.id } })) === 0)
  check("removal recorded", !!(await prisma.machineAction.findFirst({ where: { machineId: m.id, action: "project.remove", target: root } })))
  check("removing again says so", !(await removeProject(p.id, null)).ok)
}

async function cleanup() {
  const n = await prisma.project.deleteMany({ where: { name: { startsWith: "selftest-" } } })
  console.log(`  removed ${n.count} selftest project(s)`)
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === "check" && a && b) await checkAll(a, b)
  else if (cmd === "cleanup") await cleanup()
  else throw new Error("usage: projects-selftest.ts check <machine id> <root> | cleanup")
  if (cmd === "check") console.log(failed === 0 ? "PASS" : `FAIL (${failed})`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
