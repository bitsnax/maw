/**
 * Self-test for lib/crypto.ts. Prints PASS or exits 1.
 *
 * Run from /opt/maw (uses MAW_ENCRYPTION_KEY from .env via the migrate image):
 *   docker compose run --rm --no-deps migrate npx tsx scripts/crypto-selftest.ts
 */

import { randomBytes } from "node:crypto"
import { encryptSecret, decryptSecret } from "../lib/crypto"

let failed = 0
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`)
  if (!ok) failed++
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false } catch { return true }
}

const secret = "-----BEGIN PRIVATE KEY-----\nexample ✓\n-----END PRIVATE KEY-----\n"

const a = encryptSecret(secret)
const b = encryptSecret(secret)
check("round trip returns the original", decryptSecret(a) === secret)
check("stored value starts with v1:", a.startsWith("v1:"))
check("same secret encrypts differently each time", a !== b)
check("stored value does not contain the secret", !a.includes("PRIVATE KEY"))

const raw = Buffer.from(a.slice(3), "base64")
raw[raw.length - 1] ^= 0xff
check("altered value is refused", throws(() => decryptSecret("v1:" + raw.toString("base64"))))
check("unknown format is refused", throws(() => decryptSecret("plain text")))

const realKey = process.env.MAW_ENCRYPTION_KEY
process.env.MAW_ENCRYPTION_KEY = randomBytes(32).toString("base64")
check("a different key cannot decrypt", throws(() => decryptSecret(a)))
process.env.MAW_ENCRYPTION_KEY = "too-short"
check("a key of the wrong length is refused", throws(() => encryptSecret("x")))
process.env.MAW_ENCRYPTION_KEY = realKey

console.log(failed === 0 ? "PASS" : `FAIL (${failed})`)
process.exit(failed === 0 ? 0 : 1)
