/**
 * Writes THROWAWAY certificates for testing maw-agent by hand: a fresh CA
 * (not MAW's stored one), MAW's client certificate, an agent certificate
 * for 127.0.0.1, and a client certificate from a second, foreign CA.
 *
 *   docker compose run --rm --no-deps -v "$DIR:/out" migrate \
 *     npx tsx scripts/agent-testcerts.ts /out
 *
 * Files are world-readable on purpose (test only); delete the folder after.
 */

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createPki, issueAgentCert } from "../lib/pki"

async function main() {
  const out = process.argv[2]
  if (!out) throw new Error("usage: agent-testcerts.ts <output dir>")
  const pki = await createPki()
  const agent = await issueAgentCert(pki.ca, "testagent", "127.0.0.1")
  const foreign = await createPki()
  const files: Record<string, string> = {
    "ca.pem": pki.ca.certPem,
    "client.pem": pki.client.certPem,
    "client.key": pki.client.keyPem,
    "agent.pem": agent.certPem,
    "agent.key": agent.keyPem,
    "foreign-client.pem": foreign.client.certPem,
    "foreign-client.key": foreign.client.keyPem,
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(out, name), body, { mode: 0o644 })
  console.log(`wrote ${Object.keys(files).length} files; agent fingerprint ${agent.fingerprint}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
