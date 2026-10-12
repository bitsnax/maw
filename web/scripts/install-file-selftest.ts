/**
 * Writes two sample install files (no database, throwaway certificates):
 *   ip.yaml    machine at 192.168.4.202 (port published on that address)
 *   name.yaml  machine at caw-box.lan.arpa (port published on all)
 * plus the expected key in key-ip.pem, so machines-06.sh can check with
 * `docker compose config` that Docker reads the file and gets the exact key.
 *
 *   docker compose run --rm --no-deps -v "$DIR:/out" migrate \
 *     npx tsx scripts/install-file-selftest.ts /out
 */

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createPki, issueAgentCert } from "../lib/pki"
import { installFile } from "../lib/install-file"

async function main() {
  const out = process.argv[2]
  if (!out) throw new Error("usage: install-file-selftest.ts <dir>")
  const pki = await createPki()
  for (const [file, address] of [["ip.yaml", "192.168.4.202"], ["name.yaml", "caw-box.lan.arpa"]] as const) {
    const id = `test-${file.split(".")[0]}`
    const cert = await issueAgentCert(pki.ca, id, address)
    const yaml = installFile(
      { name: "caw-box", address, port: 7017, runAs: "bitsnax" },
      { machineId: id, certPem: cert.certPem, keyPem: cert.keyPem, caPem: pki.ca.certPem },
    )
    writeFileSync(join(out, file), yaml, { mode: 0o644 })
    if (file === "ip.yaml") writeFileSync(join(out, "key-ip.pem"), cert.keyPem, { mode: 0o644 })
  }
  console.log("wrote ip.yaml, name.yaml, key-ip.pem")
}

main().catch((e) => { console.error(e); process.exit(1) })
