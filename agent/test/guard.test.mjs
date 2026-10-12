// Root confinement (src/guard.ts). Runs in the image build: a failure stops the build.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkRoot, resolveInRoot, GuardError } from "../dist/guard.js"

// A fake "/opt": base/proj (the project root), base/other, outside (not in base).
const top = realpathSync(mkdtempSync(path.join(tmpdir(), "guard-")))
const base = path.join(top, "opt")
const proj = path.join(base, "proj")
const other = path.join(base, "other")
const outside = path.join(top, "outside")
for (const d of [proj, path.join(proj, "src"), other, outside]) mkdirSync(d, { recursive: true })
writeFileSync(path.join(proj, "src", "a.ts"), "a")
writeFileSync(path.join(other, "secret"), "s")
writeFileSync(path.join(outside, "secret"), "s")
symlinkSync(path.join(outside, "secret"), path.join(proj, "link-out"))       // file link leaving base
symlinkSync(other, path.join(proj, "link-sibling"))                          // folder link to another project
symlinkSync(path.join(proj, "src"), path.join(proj, "link-in"))              // folder link staying inside
symlinkSync(outside, path.join(base, "outside-root"))                        // a "root" that is really outside

const refused = (fn, re) => assert.throws(fn, (e) => e instanceof GuardError && re.test(e.message))

test("root: inside the base is accepted", () => {
  assert.equal(checkRoot(proj, base), proj)
})
test("root: relative, missing, a file, outside the base, or a link leaving the base are refused", () => {
  refused(() => checkRoot("opt/proj", base), /absolute/)
  refused(() => checkRoot(path.join(base, "nope"), base), /does not exist/)
  refused(() => checkRoot(path.join(proj, "src", "a.ts"), base), /not a folder/)
  refused(() => checkRoot(outside, base), /outside/)
  refused(() => checkRoot(path.join(base, "outside-root"), base), /outside/)
})
test("path: relative and absolute paths inside the root resolve", () => {
  assert.equal(resolveInRoot(proj, "src/a.ts", base).abs, path.join(proj, "src", "a.ts"))
  assert.equal(resolveInRoot(proj, path.join(proj, "src", "a.ts"), base).rel, path.join("src", "a.ts"))
  assert.equal(resolveInRoot(proj, ".", base).rel, ".")
})
test("path: .. and absolute paths that leave the root are refused", () => {
  refused(() => resolveInRoot(proj, "../other/secret", base), /outside the root/)
  refused(() => resolveInRoot(proj, "src/../../other/secret", base), /outside the root/)
  refused(() => resolveInRoot(proj, path.join(outside, "secret"), base), /outside the root/)
})
test("path: links leaving the root are refused, links staying inside are followed", () => {
  refused(() => resolveInRoot(proj, "link-out", base), /through a link/)
  refused(() => resolveInRoot(proj, "link-sibling/secret", base), /through a link/)
  assert.equal(resolveInRoot(proj, "link-in/a.ts", base).abs, path.join(proj, "src", "a.ts"))
})
test("path: a new file resolves through its nearest existing folder", () => {
  const r = resolveInRoot(proj, "src/new/deep/file.ts", base)
  assert.equal(r.exists, false)
  assert.equal(r.abs, path.join(proj, "src", "new", "deep", "file.ts"))
  refused(() => resolveInRoot(proj, "link-sibling/new-file", base), /through a link/)
})
test("path: empty and NUL are refused", () => {
  refused(() => resolveInRoot(proj, "", base), /required/)
  refused(() => resolveInRoot(proj, "a\0b", base), /NUL/)
})
