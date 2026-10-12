// Glob and search (src/search.ts), through ripgrep. Runs in the image build.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fsGlob, fsSearch } from "../dist/search.js"

// base/proj is a git project (a .git folder is enough for rg to honor .gitignore).
const top = realpathSync(mkdtempSync(path.join(tmpdir(), "search-")))
const base = path.join(top, "opt")
const proj = path.join(base, "proj")
const outside = path.join(top, "outside")
const put = (p, text) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text) }
put(path.join(proj, ".git", "HEAD"), "ref: refs/heads/main\nNEEDLE in git\n")
put(path.join(proj, ".gitignore"), "node_modules/\n*.log\n")
put(path.join(proj, "src", "a.ts"), "export const a = 1\n// NEEDLE here\n")
put(path.join(proj, "src", "b.ts"), "export const b = 2\nneedle lower\n")
put(path.join(proj, "src", "deep", "c.tsx"), "NEEDLE one\nnothing\nNEEDLE two\n")
put(path.join(proj, "README.md"), "# NEEDLE readme\n")
put(path.join(proj, ".env.example"), "NEEDLE=1\n")
put(path.join(proj, "node_modules", "pkg", "index.ts"), "NEEDLE ignored\n")
put(path.join(proj, "debug.log"), "NEEDLE ignored\n")
put(path.join(proj, "blob.bin"), Buffer.concat([Buffer.from("NEEDLE"), Buffer.alloc(64)]))
put(path.join(outside, "secret.ts"), "NEEDLE outside\n")
symlinkSync(outside, path.join(proj, "link-out"))
// Oldest to newest: a.ts, b.ts, c.tsx
const t = Date.now() / 1000
utimesSync(path.join(proj, "src", "a.ts"), t - 300, t - 300)
utimesSync(path.join(proj, "src", "b.ts"), t - 200, t - 200)
utimesSync(path.join(proj, "src", "deep", "c.tsx"), t - 100, t - 100)

const o = { base }
const files = async (b) => (await fsGlob(o, { root: proj, ...b })).files
const hits = async (b) => (await fsSearch(o, { root: proj, ...b })).matches
const refused = async (p, status, re) =>
  assert.rejects(p, (e) => (status === undefined || e.status === status) && re.test(e.message))

test("glob: matches at any depth, newest first", async () => {
  assert.deepEqual(await files({ pattern: "*.ts" }), ["src/b.ts", "src/a.ts"])
  assert.deepEqual(await files({ pattern: "*.{ts,tsx}" }), ["src/deep/c.tsx", "src/b.ts", "src/a.ts"])
  assert.deepEqual(await files({ pattern: "src/deep/**" }), ["src/deep/c.tsx"])
})
test("glob: .gitignore respected, hidden files included, .git and links out never listed", async () => {
  const all = await files({ pattern: "*" })
  assert.ok(all.includes(".env.example"), all)
  assert.ok(all.includes(".gitignore"), all)
  for (const f of all) {
    assert.ok(!f.startsWith(".git/"), f)
    assert.ok(!f.startsWith("node_modules/"), f)
    assert.ok(!f.startsWith("link-out"), f)
    assert.ok(!f.endsWith(".log"), f)
  }
})
test("glob: inside a sub-folder, limit and truncated", async () => {
  const r = await fsGlob(o, { root: proj, path: "src", pattern: "*.ts" })
  assert.deepEqual(r.files, ["src/b.ts", "src/a.ts"])
  const l = await fsGlob(o, { root: proj, pattern: "*", limit: 2 })
  assert.equal(l.files.length, 2)
  assert.equal(l.truncated, true)
  assert.equal((await fsGlob(o, { root: proj, pattern: "*.nothing" })).files.length, 0)
})
test("search: file, line and text; sorted; binary, ignored, .git and links out skipped", async () => {
  const m = await hits({ pattern: "NEEDLE" })
  assert.deepEqual(m.map((x) => `${x.file}:${x.line}`), [
    ".env.example:1", "README.md:1", "src/a.ts:2", "src/deep/c.tsx:1", "src/deep/c.tsx:3",
  ])
  assert.equal(m.find((x) => x.file === "src/a.ts").text, "// NEEDLE here")
})
test("search: ignoreCase, include, regex, sub-folder", async () => {
  assert.equal((await hits({ pattern: "needle", ignoreCase: true, include: "*.ts" })).length, 2)
  assert.deepEqual((await hits({ pattern: "NEEDLE (one|two)" })).map((x) => x.line), [1, 3])
  assert.deepEqual((await hits({ pattern: "NEEDLE", path: "src/deep" })).map((x) => x.file), ["src/deep/c.tsx", "src/deep/c.tsx"])
  assert.deepEqual(await hits({ pattern: "-not-an-option" }), [])
  // An include never brings ignored files back (rg's own --glob would).
  assert.deepEqual(await hits({ pattern: "NEEDLE", include: "*.log" }), [])
  assert.deepEqual(await hits({ pattern: "NEEDLE", include: "**/index.ts" }), [])
})
test("search: limit and truncated", async () => {
  const r = await fsSearch(o, { root: proj, pattern: "NEEDLE", limit: 2 })
  assert.equal(r.matches.length, 2)
  assert.equal(r.truncated, true)
})
test("refused: bad pattern, outside the root, missing or a file as folder", async () => {
  await refused(fsSearch(o, { root: proj, pattern: "(unclosed" }), 400, /Invalid pattern/)
  await refused(fsSearch(o, { root: proj, pattern: "" }), 400, /non-empty/)
  await refused(fsGlob(o, { root: proj, pattern: "*", path: "../" }), 400, /outside the root/)
  await refused(fsGlob(o, { root: proj, pattern: "*", path: "link-out" }), 400, /through a link/)
  await refused(fsGlob(o, { root: outside, pattern: "*" }), 400, /outside/)
  await refused(fsGlob(o, { root: proj, pattern: "*", path: "nope" }), 404, /does not exist/)
  await refused(fsGlob(o, { root: proj, pattern: "*", path: "README.md" }), 400, /not a folder/)
})
test("time limit: results so far, truncated", async () => {
  const r = await fsSearch({ base, timeoutMs: 1 }, { root: proj, pattern: "NEEDLE" })
  assert.equal(r.truncated, true)
})
test("glob patterns: names at any depth, paths from the root", async () => {
  const { globToRegExp } = await import("../dist/search.js")
  const m = (g, p) => { const { re, byName } = globToRegExp(g); return re.test(byName ? path.basename(p) : p) }
  assert.ok(m("*.ts", "a/b/c.ts")); assert.ok(!m("*.ts", "a/b/c.tsx"))
  assert.ok(m("*.{ts,tsx}", "x/c.tsx")); assert.ok(m("file?.md", "file1.md")); assert.ok(!m("file?.md", "file10.md"))
  assert.ok(m("src/**/*.ts", "src/a.ts")); assert.ok(m("src/**/*.ts", "src/x/y/a.ts")); assert.ok(!m("src/**/*.ts", "lib/src/a.ts"))
  assert.ok(m("**/*.json", "package.json")); assert.ok(m("**/*.json", "web/package.json"))
  assert.ok(m("src/deep/**", "src/deep/c.tsx")); assert.ok(!m("src/deep/**", "src/deeper/c.tsx"))
  assert.ok(m("/README.md", "README.md")); assert.ok(!m("/README.md", "docs/README.md"))
  assert.ok(m("[ab].ts", "a.ts")); assert.ok(!m("[!ab].ts", "a.ts")); assert.ok(m("[!ab].ts", "c.ts"))
  assert.ok(m("a+b(1).txt", "a+b(1).txt")); assert.ok(!m("a.b", "axb"))
  assert.throws(() => globToRegExp("*.{ts"), /unclosed/)
})
