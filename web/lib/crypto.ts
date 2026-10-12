import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

// Secrets at rest — AES-256-GCM with MAW_ENCRYPTION_KEY.
//
// Used for the private keys MAW stores (its certificate authority and its
// own client certificate, table `pki`). Server-side only: never import this
// from a "use client" file.
//
// Stored format:  "v1:" + base64( iv[12] | tag[16] | ciphertext )
//   - iv: random per value, so the same secret never encrypts the same way
//   - tag: GCM authentication tag; a changed byte makes decryptSecret throw
//
// MAW_ENCRYPTION_KEY is base64 of 32 random bytes (openssl rand -base64 32).
// NEVER rotate it once a machine is paired: the stored CA key becomes
// unreadable and every machine has to be paired again.

const PREFIX = "v1:"
const IV_BYTES = 12
const TAG_BYTES = 16

function key(): Buffer {
  const raw = process.env.MAW_ENCRYPTION_KEY
  if (!raw) throw new Error("MAW_ENCRYPTION_KEY is not set.")
  const k = Buffer.from(raw, "base64")
  if (k.length !== 32) {
    throw new Error("MAW_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).")
  }
  return k
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, body]).toString("base64")
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) throw new Error("Unknown secret format.")
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64")
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Stored secret is too short.")
  const iv = raw.subarray(0, IV_BYTES)
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = raw.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv("aes-256-gcm", key(), iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")
  } catch {
    throw new Error("Stored secret could not be decrypted (wrong MAW_ENCRYPTION_KEY or altered data).")
  }
}
