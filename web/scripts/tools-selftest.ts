/**
 * Self-test for the tool API (lib/tools.ts, route /api/tools/<tool>) against
 * a REAL maw-agent, through the same handler the route uses, with real
 * Request objects. Uses MAW's database: a temporary machine (made with
 * remote-selftest.ts issue), a project named selftest-* and a session row,
 * removed by `cleanup`.
 *
 * Driven by phase3-02.sh (run from /opt/maw, in the migrate container):
 *   check <machine id> <root>   root: an existing empty folder inside /opt
 *   http <base url>             the deployed route answers (token, refusals)
 *   cleanup
 */

import { prisma } from "../lib/prisma"
import { createProject } from "../lib/projects"
import { handleToolRequest, mapPath, OutputTail, WORKSPACES } from "../lib/tools"
import { listMachineCommands } from "../lib/machines"

let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  const d = detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}`
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : d}`)
  if (!ok) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const TOKEN = "t".repeat(40) + "selftest-token-0123456789"
type Res = { status: number; ok: boolean; output?: string; message?: string; title?: string; metadata?: Record<string, unknown> }

function request(tool: string, body: unknown, token: string | null = TOKEN, signal?: AbortSignal) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token !== null) headers.authorization = `Bearer ${token}`
  return new Request(`http://maw/api/tools/${tool}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body), signal })
}

async function checkAll(machineId: string, root: string) {
  process.env.MAW_TOOLS_TOKEN = TOKEN
  const tag = `selftest-${Date.now() % 100000}`
  const p = await createProject({ name: tag, machineId, root }, null)
  if (!p.ok) { check("project for the test", false, p); return }
  const ws = `${WORKSPACES}/${p.project.slug}`
  const user = await prisma.user.findFirst({ select: { id: true } })
  const sessionID = `ses_${tag}`
  await prisma.projectSession.create({ data: { id: sessionID, projectId: p.project.id, title: "tools selftest", userId: user?.id ?? null } })
  const call = async (tool: string, args: Record<string, unknown>, sid = sessionID, dir = ws): Promise<Res> => {
    const r = await handleToolRequest(tool, request(tool, { sessionID: sid, directory: dir, args }))
    return { status: r.status, ...(await r.json()) }
  }

  console.log("token and request")
  delete process.env.MAW_TOOLS_TOKEN
  check("no token configured: 503", (await handleToolRequest("read", request("read", {}))).status === 503)
  process.env.MAW_TOOLS_TOKEN = TOKEN
  check("no token sent: 401", (await handleToolRequest("read", request("read", {}, null))).status === 401)
  check("wrong token: 401", (await handleToolRequest("read", request("read", {}, TOKEN.replace("t", "u")))).status === 401)
  check("unknown tool: 404", (await handleToolRequest("list", request("list", {}))).status === 404)
  check("not JSON: 400", (await handleToolRequest("read", request("read", "nope"))).status === 400)
  const unknownWs = await call("read", { filePath: "x" }, sessionID, `${WORKSPACES}/no-such-project`)
  check("unknown workspace: 404, said plainly", unknownWs.status === 404 && /No MAW project has the workspace/.test(unknownWs.message ?? ""), unknownWs)
  const notWs = await call("read", { filePath: "x" }, sessionID, "/tmp/elsewhere")
  check("a folder that is not a workspace: 400", notWs.status === 400, notWs)

  console.log("paths")
  const ctx = { workspace: ws, project: { root, machine: { name: "m" } } }
  check("relative → in the project folder", mapPath(ctx, "src/a.ts") === `${root}/src/a.ts`)
  check("workspace path → in the project folder", mapPath(ctx, `${ws}/src/a.ts`) === `${root}/src/a.ts` && mapPath(ctx, ws) === root)
  check("project folder path kept", mapPath(ctx, `${root}/src/a.ts`) === `${root}/src/a.ts`)
  check("empty → the project folder", mapPath(ctx, undefined) === root)
  let refused = ""
  try { mapPath(ctx, "/etc/passwd") } catch (e) { refused = (e as Error).message }
  check("outside the project: refused, said plainly", /is outside the project folder/.test(refused), refused)
  refused = ""
  try { mapPath(ctx, "../../etc/passwd") } catch (e) { refused = (e as Error).message }
  check("../ out of the project: refused", /is outside the project folder/.test(refused), refused)
  refused = ""
  try { mapPath(ctx, `${root}-other/x`) } catch (e) { refused = (e as Error).message }
  check("a sibling folder with the same prefix: refused", /is outside/.test(refused), refused)

  console.log("write, read, edit")
  const w = await call("write", { filePath: "src/a.ts", content: "alpha\nNEEDLE beta\ngamma\n" })
  check("write (relative path): OpenCode's answer", w.ok && w.output === "Wrote file successfully." && w.title === "src/a.ts", w)
  const w2 = await call("write", { filePath: `${ws}/src/deep/b.ts`, content: "one\ntwo NEEDLE\n" })
  check("write (workspace path, new folders)", w2.ok, w2)
  const r = await call("read", { filePath: `${root}/src/a.ts` })
  check("read: <path>, numbered lines, end of file", r.ok && r.output ===
    `<path>${root}/src/a.ts</path>\n<type>file</type>\n<content>\n1: alpha\n2: NEEDLE beta\n3: gamma\n\n(End of file - total 3 lines)\n</content>`, r.output)
  await call("write", { filePath: "big.txt", content: Array.from({ length: 2500 }, (_, i) => String(i + 1)).join("\n") + "\n" })
  const r2 = await call("read", { filePath: "big.txt", limit: 3 })
  check("read limit: 'Showing lines 1-3 of 2500. Use offset=4'", r2.ok && r2.output!.includes("1: 1\n2: 2\n3: 3\n\n(Showing lines 1-3 of 2500. Use offset=4 to continue.)"), r2.output)
  const r3 = await call("read", { filePath: "big.txt", offset: 2499 })
  check("read offset is 1-indexed", r3.ok && r3.output!.includes("2499: 2499\n2500: 2500\n\n(End of file - total 2500 lines)"), r3.output)
  const r4 = await call("read", { filePath: "big.txt" })
  check("read: 2,000 lines by default", r4.ok && r4.output!.includes("(Showing lines 1-2000 of 2500. Use offset=2001 to continue.)"))
  const rd = await call("read", { filePath: "src" })
  check("read a folder: its entries", rd.ok && rd.output === `<path>${root}/src</path>\n<type>directory</type>\n<entries>\na.ts\ndeep/\n\n(2 entries)\n</entries>`, rd.output)
  const rm = await call("read", { filePath: "nope.txt" })
  check("read a missing file: 'File not found'", !rm.ok && rm.message === `File not found: ${root}/nope.txt`, rm)
  const ro = await call("read", { filePath: "/etc/passwd" })
  check("read outside the project: refused", !ro.ok && ro.status === 400, ro)
  const e1 = await call("edit", { filePath: "src/a.ts", oldString: "gamma", newString: "delta" })
  check("edit: 'Edit applied successfully.'", e1.ok && e1.output === "Edit applied successfully.", e1)
  const e2 = await call("edit", { filePath: "src/a.ts", oldString: "zzz", newString: "y" })
  check("edit not found: OpenCode's message", !e2.ok && /^Could not find oldString in the file/.test(e2.message ?? ""), e2)
  await call("write", { filePath: "dup.txt", content: "x\nx\n" })
  const e3 = await call("edit", { filePath: "dup.txt", oldString: "x", newString: "y" })
  check("edit, several matches: OpenCode's message", !e3.ok && /^Found multiple matches for oldString/.test(e3.message ?? ""), e3)
  const e4 = await call("edit", { filePath: "dup.txt", oldString: "x", newString: "y", replaceAll: true })
  check("edit replaceAll", e4.ok && e4.metadata?.replacements === 2, e4)
  const e5 = await call("edit", { filePath: "dup.txt", oldString: "y", newString: "y" })
  check("edit identical: OpenCode's message", !e5.ok && /^No changes to apply/.test(e5.message ?? ""), e5)
  const e6 = await call("edit", { filePath: "made-by-edit.txt", oldString: "", newString: "fresh\n" })
  const e6r = await call("read", { filePath: "made-by-edit.txt" })
  check("edit with empty oldString writes the file", e6.ok && e6r.output!.includes("1: fresh"), [e6, e6r.output])

  console.log("glob and grep")
  const g = await call("glob", { pattern: "**/*.ts" })
  check("glob: absolute paths on the machine", g.ok && g.output!.split("\n").sort().join() === [`${root}/src/a.ts`, `${root}/src/deep/b.ts`].join(), g.output)
  const g0 = await call("glob", { pattern: "*.zzz" })
  check("glob, nothing: 'No files found'", g0.ok && g0.output === "No files found", g0)
  for (let i = 1; i <= 105; i++) await call("write", { filePath: `many/f${i}.txt`, content: `MANY ${i}\n` })
  const gm = await call("glob", { pattern: "many/*.txt" })
  check("glob over 100: truncated note", gm.ok && gm.output!.split("\n").length === 102 &&
    gm.output!.endsWith("(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)"), gm.output?.slice(-200))
  const s1 = await call("grep", { pattern: "NEEDLE" })
  check("grep: 'Found 2 matches', grouped by file", s1.ok && s1.output!.startsWith("Found 2 matches\n") &&
    s1.output!.includes(`${root}/src/a.ts:\n  Line 2: NEEDLE beta\n`) && s1.output!.includes(`${root}/src/deep/b.ts:\n  Line 2: two NEEDLE\n`), s1.output)
  const s2 = await call("grep", { pattern: "NEEDLE", include: "*.ts", path: "src/deep" })
  check("grep with path and include", s2.ok && s2.output!.startsWith("Found 1 matches\n"), s2.output)
  const s3 = await call("grep", { pattern: "zzzq" })
  check("grep, nothing: 'No files found'", s3.ok && s3.output === "No files found", s3)
  const s4 = await call("grep", { pattern: "MANY" })
  check("grep over 100: truncated", s4.ok && s4.output!.startsWith("Found 100 matches (more matches available)") &&
    s4.output!.trimEnd().endsWith("(Results truncated. Consider using a more specific path or pattern.)"), s4.output?.slice(0, 80))
  const s5 = await call("grep", { pattern: "(" })
  check("grep, bad regular expression: the message", !s5.ok && s5.status === 400, s5)

  console.log("bash")
  const bash = async (args: Record<string, unknown>, signal?: AbortSignal) => {
    const res = await handleToolRequest("bash", request("bash", { sessionID, directory: ws, args }, TOKEN, signal))
    if (res.headers.get("content-type")?.startsWith("application/json")) return { status: res.status, events: [await res.json()] }
    const text = await new Response(res.body).text()
    return { status: res.status, events: text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) }
  }
  const b1 = await bash({ command: "echo out; echo err >&2; exit 3" })
  const res1 = b1.events.at(-1)
  check("bash: start, live lines, result", b1.events[0]?.type === "start" && b1.events.filter((e) => e.type === "line").length === 2 && res1?.type === "result", b1.events)
  check("bash: output like OpenCode (no exit code in the text)", res1?.output === "out\nerr", res1?.output)
  check("bash: exit code in metadata", res1?.metadata?.exit === 3 && res1?.metadata?.state === "exited", res1?.metadata)
  const b2 = await bash({ command: "pwd", workdir: "src/deep" })
  check("bash workdir", b2.events.at(-1)?.output === `${root}/src/deep`, b2.events.at(-1))
  const b3 = await bash({ command: "true" })
  check("bash, no output: '(no output)'", b3.events.at(-1)?.output === "(no output)", b3.events.at(-1))
  const b4 = await bash({ command: "echo start; sleep 5; echo late", timeout: 1500 })
  const r4b = b4.events.at(-1)
  check("bash timeout: OpenCode's shell_metadata note", r4b?.metadata?.state === "timed_out" && /^start\n\n<shell_metadata>\nshell tool terminated command after exceeding timeout 1500 ms/.test(r4b?.output ?? ""), r4b)
  const b5 = await bash({ command: "seq 1 3000" })
  const r5 = b5.events.at(-1)
  check("bash long output: '...output truncated...' and the last 2,000 lines", /^\.\.\.output truncated\.\.\.\n\n1001\n/.test(r5?.output ?? "") && r5?.output?.endsWith("\n3000") && r5?.metadata?.truncated === true, r5?.output?.slice(0, 40))
  const b6 = await bash({ command: "cat /etc/hostname", workdir: "/etc" })
  check("bash workdir outside the project: refused", b6.status === 400, b6.events)

  const machine = await prisma.machine.findUniqueOrThrow({ where: { id: machineId } })
  // A unique, always valid duration (the tag's number may have fewer than 5 digits).
  const mark = String(Date.now() % 100000).padStart(5, "0")
  const ac = new AbortController()
  const res = await handleToolRequest("bash", request("bash", { sessionID, directory: ws, args: { command: `sleep 300.${mark}` } }, TOKEN, ac.signal))
  const reader = res.body!.getReader()
  const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("\n")[0]!)
  await sleep(800)
  ac.abort()
  await reader.cancel().catch(() => {})
  let state = "running"
  for (let i = 0; i < 40 && state === "running"; i++) {
    await sleep(250)
    const l = await listMachineCommands(machine)
    state = l.ok ? l.data.jobs.find((j) => j.id === first.jobId)?.state ?? "gone" : "?"
  }
  check("abort (OpenCode stops the tool): the command is stopped", state === "stopped", state)

  console.log("records")
  const acts = await prisma.machineAction.findMany({ where: { machineId, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } })
  const writes = acts.filter((a) => a.action === "file.write")
  check("writes recorded, with the session's user", writes.length >= 3 && writes.every((a) => a.userId === (user?.id ?? null)), writes.length)
  check("edits recorded", acts.some((a) => a.action === "file.edit" && a.target === `${root}/src/a.ts` && a.ok))
  check("commands recorded, with the session's user", acts.filter((a) => a.action === "command").length >= 6 &&
    acts.filter((a) => a.action === "command").every((a) => a.userId === (user?.id ?? null)))
  check("reads, globs and greps are not recorded", !acts.some((a) => /^file\.(read|list|glob|search)$/.test(a.action)))

  console.log("sessions")
  const other = await createProject({ name: `${tag}-b`, machineId, root: `${root}/src` }, null)
  if (other.ok) {
    const cross = await call("read", { filePath: "a.ts" }, sessionID, `${WORKSPACES}/${other.project.slug}`)
    check("a session of another project: refused", cross.status === 400 && /another project/.test(cross.message ?? ""), cross)
  } else check("second project", false, other)
  const anon = await call("read", { filePath: "src/a.ts" }, "ses_unknown")
  check("an unknown session still works (no user)", anon.ok)

  console.log("output tail")
  const t = new OutputTail()
  for (let i = 0; i < 100; i++) t.push("x".repeat(1000))
  check("50 KB cap keeps the end", t.truncated && Buffer.byteLength(t.text()) <= 51200, Buffer.byteLength(t.text()))
}

async function httpCheck(base: string) {
  const post = (tool: string, token: string | null, body: unknown) =>
    fetch(`${base}/api/tools/${tool}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
  const t = process.env.MAW_TOOLS_TOKEN ?? ""
  const none = await post("read", null, {})
  check("deployed route: no token → 401 (not a redirect to sign-in)", none.status === 401, none.status)
  const bad = await post("read", "x".repeat(64), {})
  check("deployed route: wrong token → 401", bad.status === 401, bad.status)
  const ws = await post("read", t, { sessionID: "x", directory: `${WORKSPACES}/no-such-project`, args: { filePath: "a" } })
  check("deployed route: right token, unknown workspace → 404", ws.status === 404, ws.status)
}

async function cleanup() {
  const ps = await prisma.project.findMany({ where: { name: { startsWith: "selftest-" } }, select: { id: true } })
  await prisma.project.deleteMany({ where: { id: { in: ps.map((p) => p.id) } } })
  console.log(`  removed ${ps.length} selftest project(s)`)
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === "check" && a && b) await checkAll(a, b)
  else if (cmd === "http" && a) await httpCheck(a)
  else if (cmd === "cleanup") await cleanup()
  else throw new Error("usage: tools-selftest.ts check <machine id> <root> | http <base url> | cleanup")
  if (cmd !== "cleanup") console.log(failed === 0 ? "PASS" : `FAIL (${failed})`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
