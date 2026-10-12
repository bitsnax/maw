// Commands (src/exec.ts). Runs in the image build. The host launcher
// (nsenter + runuser) needs the host, so here the script runs in sh
// directly; everything else (script, output, limits, stopping the whole
// process tree through /proc) is the real code.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, realpathSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { ExecManager, commandScript, parseStat, checkCommands, BEGIN_MARK } from "../dist/exec.js"

const top = realpathSync(mkdtempSync(path.join(tmpdir(), "exec-")))
const base = path.join(top, "opt")
const proj = path.join(base, "it's a proj")
mkdirSync(proj, { recursive: true })

const identity = { ok: true, user: "dev", uid: process.getuid(), gid: process.getgid(), home: top, lang: "C.UTF-8" }
const sh = (_user, script) => ({ file: "/bin/sh", args: ["-c", script] })
const make = (o = {}) => new ExecManager({ base, identity: () => identity, launcher: sh, killGraceMs: 700, ...o })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitEnd(m, id, ms = 10000) {
  const until = Date.now() + ms
  for (;;) {
    const s = m.describe(id, "2000")
    if (s.state !== "running") return s
    if (Date.now() > until) throw new Error(`still running: ${JSON.stringify(s)}`)
    await sleep(50)
  }
}
const out = (s) => s.lines.filter((l) => l.stream === "stdout").map((l) => l.text)
const alive = (pid) => {
  try { return !["Z", "X"].includes(parseStat(readFileSync(`/proc/${pid}/stat`, "utf8")).state) } catch { return false }
}

test("script: any command text survives, in the root, umask 0002, LANG", () => {
  const cmd = `printf '%s|' "a'b" 'c"d' '$HOME' "\\\\n"; echo; pwd; umask; echo "$LANG"`
  const got = execFileSync("/bin/sh", ["-c", commandScript(proj, cmd, "en_US.UTF-8")], { encoding: "utf8", env: {} })
  assert.equal(got, `${BEGIN_MARK}\na'b|c"d|$HOME|\\n|\n${proj}\n0002\nen_US.UTF-8\n`)
  assert.ok(!commandScript(proj, "rm -rf /x", "C").includes("rm -rf"), "the command is encoded, not inline")
})

test("runs: stdout and stderr lines, exit code, duration", async () => {
  const m = make()
  const j = m.start({ root: proj, command: "echo one; echo two >&2; printf 'no newline'; exit 3" })
  assert.equal(j.state, "running")
  const s = await waitEnd(m, j.id)
  assert.equal(s.state, "exited")
  assert.equal(s.exitCode, 3)
  assert.deepEqual(out(s), ["one", "no newline"])
  assert.deepEqual(s.lines.filter((l) => l.stream === "stderr").map((l) => l.text), ["two"])
  assert.ok(s.durationMs >= 0 && s.endedAt)
})

test("refusals: root outside the base, empty command, bad limit, no host user", () => {
  const m = make()
  assert.throws(() => m.start({ root: top, command: "true" }), (e) => e.status === 400 && /outside/.test(e.message))
  assert.throws(() => m.start({ root: proj, command: "  " }), (e) => e.status === 400)
  assert.throws(() => m.start({ root: proj, command: "true", timeoutSeconds: 3601 }), (e) => e.status === 400)
  const none = new ExecManager({ base, identity: () => ({ ok: false, user: "dev", error: "no passwd" }), launcher: sh })
  assert.throws(() => none.start({ root: proj, command: "true" }), (e) => e.status === 503 && /no passwd/.test(e.message))
  assert.throws(() => m.describe("0123456789abcdef"), (e) => e.status === 404)
})

test("time limit: ends as timed_out, nothing left running", async () => {
  const m = make()
  const j = m.start({ root: proj, command: "sleep 30 & echo $!; wait", timeoutSeconds: 1 })
  const s = await waitEnd(m, j.id)
  assert.equal(s.state, "timed_out")
  const pid = Number(out(s)[0])
  assert.ok(pid > 0)
  assert.equal(alive(pid), false)
})

test("stop: TERM, then KILL for what ignores it; the whole tree ends", async () => {
  const m = make()
  // A child that ignores TERM, and a grandchild whose parent exits early (re-parented).
  const j = m.start({ root: proj, command: "trap '' TERM; (trap '' TERM; sleep 300) & echo $!; (sleep 301 & echo $!) ; wait" })
  await sleep(400)
  const pids = out(m.describe(j.id)).map(Number)
  assert.equal(pids.length, 2)
  assert.ok(pids.every(alive), "started")
  const t0 = Date.now()
  const s = await m.stop(j.id)
  assert.equal(s.state, "stopped")
  assert.ok(Date.now() - t0 >= 600, "waited for the grace period before KILL")
  for (const p of pids) assert.equal(alive(p), false, `pid ${p} still alive`)
})

test("leftovers: a background process outlives the command only until it exits", async () => {
  const m = make()
  const j = m.start({ root: proj, command: "sleep 300 >/dev/null 2>&1 & echo $!" })
  const s = await waitEnd(m, j.id)
  assert.equal(s.state, "exited")
  assert.equal(s.exitCode, 0)
  const pid = Number(out(s)[0])
  const until = Date.now() + 3000
  while (alive(pid) && Date.now() < until) await sleep(50)
  assert.equal(alive(pid), false)
})

test("limits: 4 running at once; long lines cut; last N lines kept", async () => {
  const m = make({ maxLines: 50 })
  const ids = [0, 1, 2, 3].map(() => m.start({ root: proj, command: "sleep 5" }).id)
  assert.throws(() => m.start({ root: proj, command: "true" }), (e) => e.status === 429)
  await Promise.all(ids.map((id) => m.stop(id)))
  const j = m.start({ root: proj, command: "i=0; while [ $i -lt 120 ]; do echo line$i; i=$((i+1)); done; head -c 9000 /dev/zero | tr '\\0' x" })
  const s = await waitEnd(m, j.id)
  assert.equal(s.totalLines, 123)
  assert.equal(s.lines.length, 50)
  assert.equal(s.droppedLines, 73)
  assert.equal(s.lines.at(-1).text, "x".repeat(1000))
  assert.equal(s.lines.at(-2).text.length, 4000)
})

test("stream: kept lines after a seq, live lines, then the end", async () => {
  const m = make()
  const j = m.start({ root: proj, command: "echo a; echo b; sleep 0.5; echo c" })
  await sleep(250)
  const events = []
  const done = new Promise((resolve) => {
    const sub = m.subscribe(j.id, 1, (e) => { events.push(e); if (e.type === "end") resolve() })
    events.unshift(...sub.lines.map((line) => ({ type: "line", line })))
  })
  await done
  assert.deepEqual(events.filter((e) => e.type === "line").map((e) => e.line.text), ["b", "c"])
  assert.equal(events.at(-1).status.state, "exited")
  // After the end: kept lines and the end, at once.
  const late = m.subscribe(j.id, 0, () => {})
  assert.equal(late.lines.length, 3)
  assert.equal(late.ended.exitCode, 0)
})

test("command check: id -u must print the user's uid", async () => {
  const ok = await checkCommands(identity, sh)
  assert.equal(ok.ok, true)
  const wrong = await checkCommands({ ...identity, uid: identity.uid + 1 }, sh)
  assert.equal(wrong.ok, false)
  assert.equal((await checkCommands({ ok: false, user: "x", error: "nope" }, sh)).ok, false)
})

test("login noise: what the shell's start-up files print is flagged, not the command's output", async () => {
  // As on a host whose ~/.bashrc fails a line before the command runs.
  const noisy = (_user, script) => ({ file: "/bin/sh", args: ["-c", `echo "init.sh: pyenv: command not found" >&2; echo motd; ${script}`] })
  const m = make({ launcher: noisy })
  const s = await waitEnd(m, m.start({ root: proj, command: "echo out; echo err >&2" }).id)
  assert.deepEqual(s.lines.filter((l) => l.login).map((l) => l.text).sort(), ["init.sh: pyenv: command not found", "motd"])
  assert.deepEqual(s.lines.filter((l) => !l.login).map((l) => `${l.stream}:${l.text}`).sort(), ["stderr:err", "stdout:out"])
  assert.ok(s.lines.every((l) => l.text !== BEGIN_MARK), "the marker itself is never shown")
  assert.equal(s.totalLines, 4)
})
