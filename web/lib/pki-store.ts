import { prisma } from "./prisma"
import { encryptSecret, decryptSecret } from "./crypto"
import { createPki, type Pki } from "./pki"

// MAW's certificate authority, stored in table `pki` (one row, id "maw").
// Created the first time anything needs it; private keys are stored
// encrypted with MAW_ENCRYPTION_KEY and only decrypted in memory.

const PKI_ID = "maw"
let cached: Promise<Pki> | null = null

async function loadOrCreate(): Promise<Pki> {
  let row = await prisma.pki.findUnique({ where: { id: PKI_ID } })
  if (!row) {
    const fresh = await createPki()
    // Two first requests at once: one row wins, both use what is stored.
    row = await prisma.pki.upsert({
      where: { id: PKI_ID },
      update: {},
      create: {
        id: PKI_ID,
        caCertPem: fresh.ca.certPem,
        caKeyEnc: encryptSecret(fresh.ca.keyPem),
        clientCertPem: fresh.client.certPem,
        clientKeyEnc: encryptSecret(fresh.client.keyPem),
      },
    })
  }
  return {
    ca: { certPem: row.caCertPem, keyPem: decryptSecret(row.caKeyEnc) },
    client: { certPem: row.clientCertPem, keyPem: decryptSecret(row.clientKeyEnc) },
  }
}

/** MAW's CA and client certificate (created on first use, then cached). */
export function getPki(): Promise<Pki> {
  if (!cached) {
    cached = loadOrCreate().catch((e) => {
      cached = null // let the next call try again
      throw e
    })
  }
  return cached
}
