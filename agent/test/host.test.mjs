// Host identity parsing (src/host.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parsePasswd, parseLocale, readHostIdentity } from "../dist/host.js"

const passwd = "root:x:0:0:root:/root:/bin/bash\nbitsnax:x:1000:1000:bitsnax,,,:/home/bitsnax:/bin/bash\n"

test("passwd: finds the user", () => {
  assert.deepEqual(parsePasswd(passwd, "bitsnax"), { uid: 1000, gid: 1000, home: "/home/bitsnax" })
  assert.equal(parsePasswd(passwd, "nobody-here"), null)
})
test("locale: reads LANG, quoted or not; default C.UTF-8", () => {
  assert.equal(parseLocale('LANG=en_US.UTF-8\n'), "en_US.UTF-8")
  assert.equal(parseLocale('# comment\nLANG="de_DE.UTF-8"\n'), "de_DE.UTF-8")
  assert.equal(parseLocale(""), "C.UTF-8")
})
test("identity from a host root folder", () => {
  const root = mkdtempSync(path.join(tmpdir(), "host-"))
  mkdirSync(path.join(root, "etc", "default"), { recursive: true })
  writeFileSync(path.join(root, "etc", "passwd"), passwd)
  writeFileSync(path.join(root, "etc", "default", "locale"), "LANG=en_US.UTF-8\n")
  assert.deepEqual(readHostIdentity("bitsnax", root), { ok: true, user: "bitsnax", uid: 1000, gid: 1000, home: "/home/bitsnax", lang: "en_US.UTF-8" })
  assert.match(readHostIdentity("ghost", root).error, /does not exist/)
  assert.match(readHostIdentity("", root).error, /MAW_RUN_AS/)
  assert.match(readHostIdentity("bitsnax", path.join(root, "nope")).error, /pid: host/)
})
