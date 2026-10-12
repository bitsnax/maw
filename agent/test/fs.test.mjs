// File endpoints (src/fs.ts). Runs in the image build (as root, so chown works).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, symlinkSync, realpathSync, chmodSync, chownSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fsRead, fsList, fsWrite, fsEdit } from "../dist/fs.js"

const top = realpathSync(mkdtempSync(path.join(tmpdir(), "fs-")))
const base = path.join(top, "opt")
const proj = path.join(base, "proj")
const outside = path.join(top, "outside")
for (const d of [path.join(proj, "src"), outside]) mkdirSync(d, { recursive: true })
writeFileSync(path.join(proj, "src", "a.ts"), "one\ntwo\nthree\n")
writeFileSync(path.join(proj, "bin.dat"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))
writeFileSync(path.join(proj, "big.txt"), "x".repeat(2 * 1024 * 1024 + 1))
writeFileSync(path.join(outside, "secret"), "s")
symlinkSync(path.join(outside, "secret"), path.join(proj, "link-out"))
symlinkSync(path.join(proj, "src"), path.join(proj, "link-src"))
symlinkSync(path.join(proj, "gone"), path.join(proj, "broken"))

// A user other than the one running the tests, so ownership is really changed.
const owner = { ok: true, user: "dev", uid: 1234, gid: 2345, home: "/home/dev", lang: "C.UTF-8" }
const o = { base, identity: owner }
const noUser = { base, identity: { ok: false, user: "dev", error: "Cannot read the host's /etc/passwd" } }
const mode = (p) => statSync(p).mode & 0o777
const refused = (fn, status, re) =>
  assert.throws(fn, (e) => (status === undefined || e.status === status) && re.test(e.message))

test("read: numbered lines, offset and limit", () => {
  const r = fsRead(o, { root: proj, path: "src/a.ts" })
  assert.equal(r.content, "00001| one\n00002| two\n00003| three")
  assert.equal(r.totalLines, 3)
  assert.equal(r.more, false)
  const p = fsRead(o, { root: proj, path: "src/a.ts", offset: 1, limit: 1 })
  assert.equal(p.content, "00002| two")
  assert.equal(p.more, true)
  assert.equal(fsRead(o, { root: proj, path: "link-src/a.ts" }).path, path.join("src", "a.ts"))
})
test("read: binary, over 2 MB, folders, missing and outside the root are refused", () => {
  refused(() => fsRead(o, { root: proj, path: "bin.dat" }), 415, /binary/)
  refused(() => fsRead(o, { root: proj, path: "big.txt" }), 413, /over 2 MB/)
  refused(() => fsRead(o, { root: proj, path: "src" }), 400, /folder/)
  refused(() => fsRead(o, { root: proj, path: "nope.txt" }), 404, /does not exist/)
  refused(() => fsRead(o, { root: proj, path: "link-out" }), 400, /through a link/)
  refused(() => fsRead(o, { root: proj, path: "../../outside/secret" }), 400, /outside the root/)
  refused(() => fsRead(o, { root: outside, path: "secret" }), 400, /outside/)
  refused(() => fsRead(o, { root: proj, path: 5 }), 400, /must be a string/)
})
test("list: folders first, links with their target, broken links shown", () => {
  const l = fsList(o, { root: proj })
  const names = l.entries.map((e) => e.name)
  assert.deepEqual(names.slice(0, 2), ["link-src", "src"])
  const byName = Object.fromEntries(l.entries.map((e) => [e.name, e]))
  assert.equal(byName["src"].type, "dir")
  assert.equal(byName["link-src"].type, "link")
  assert.equal(byName["link-src"].target, "dir")
  assert.equal(byName["broken"].target, "broken")
  assert.equal(byName["bin.dat"].size, 6)
  assert.match(byName["bin.dat"].modified, /^\d{4}-\d\d-\d\dT/)
  refused(() => fsList(o, { root: proj, path: "src/a.ts" }), 400, /not a folder/)
})
test("write: a new file and its new folders belong to the run-as user (664 / 775)", () => {
  const w = fsWrite(o, { root: proj, path: "new/deep/file.txt", content: "hello\n" })
  assert.equal(w.created, true)
  const f = path.join(proj, "new", "deep", "file.txt")
  assert.equal(readFileSync(f, "utf8"), "hello\n")
  for (const p of [f, path.join(proj, "new"), path.join(proj, "new", "deep")]) {
    assert.equal(statSync(p).uid, 1234, p)
    assert.equal(statSync(p).gid, 2345, p)
  }
  assert.equal(mode(f), 0o664)
  assert.equal(mode(path.join(proj, "new")), 0o775)
  assert.equal(mode(path.join(proj, "new", "deep")), 0o775)
})
test("write: replacing a file keeps its owner, mode and inode", () => {
  const f = path.join(proj, "keep.sh")
  writeFileSync(f, "old")
  chownSync(f, 4321, 4321)
  chmodSync(f, 0o750)
  const ino = statSync(f).ino
  const w = fsWrite(o, { root: proj, path: "keep.sh", content: "new" })
  assert.equal(w.created, false)
  const st = statSync(f)
  assert.equal(readFileSync(f, "utf8"), "new")
  assert.deepEqual([st.uid, st.gid, st.mode & 0o777, st.ino], [4321, 4321, 0o750, ino])
})
test("write: refused without a host user, onto a folder, through a file, or outside the root", () => {
  refused(() => fsWrite(noUser, { root: proj, path: "x.txt", content: "x" }), 503, /unavailable/)
  refused(() => fsWrite(o, { root: proj, path: "src", content: "x" }), 400, /folder/)
  refused(() => fsWrite(o, { root: proj, path: "src/a.ts/inner.txt", content: "x" }), 400, /is a file/)
  refused(() => fsWrite(o, { root: proj, path: "link-out", content: "x" }), 400, /through a link/)
  refused(() => fsWrite(o, { root: proj, path: "../escape.txt", content: "x" }), 400, /outside the root/)
  assert.equal(readFileSync(path.join(outside, "secret"), "utf8"), "s")
})
test("edit: exact replace keeps owner and mode; replaceAll counts", () => {
  const f = path.join(proj, "e.txt")
  writeFileSync(f, "alpha beta alpha\n")
  chownSync(f, 4321, 4321)
  chmodSync(f, 0o640)
  assert.equal(fsEdit(o, { root: proj, path: "e.txt", oldString: "beta", newString: "gamma" }).replacements, 1)
  assert.equal(readFileSync(f, "utf8"), "alpha gamma alpha\n")
  assert.equal(fsEdit(o, { root: proj, path: "e.txt", oldString: "alpha", newString: "$&-$1", replaceAll: true }).replacements, 2)
  assert.equal(readFileSync(f, "utf8"), "$&-$1 gamma $&-$1\n")
  const st = statSync(f)
  assert.deepEqual([st.uid, st.gid, st.mode & 0o777], [4321, 4321, 0o640])
})
test("edit: not found, ambiguous, empty, unchanged and binary are refused; file untouched", () => {
  const f = path.join(proj, "amb.txt")
  writeFileSync(f, "x = 1\nx = 1\n")
  refused(() => fsEdit(o, { root: proj, path: "amb.txt", oldString: "y = 2", newString: "z" }), 422, /not found/)
  refused(() => fsEdit(o, { root: proj, path: "amb.txt", oldString: "x = 1", newString: "x = 2" }), 422, /found 2 times/)
  refused(() => fsEdit(o, { root: proj, path: "amb.txt", oldString: "", newString: "z" }), 400, /empty/)
  refused(() => fsEdit(o, { root: proj, path: "amb.txt", oldString: "x", newString: "x" }), 400, /same/)
  refused(() => fsEdit(o, { root: proj, path: "bin.dat", oldString: "E", newString: "F" }), 415, /binary/)
  refused(() => fsEdit(noUser, { root: proj, path: "amb.txt", oldString: "x", newString: "y" }), 503, /unavailable/)
  assert.equal(readFileSync(f, "utf8"), "x = 1\nx = 1\n")
})
