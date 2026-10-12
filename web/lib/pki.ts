import "reflect-metadata" // required by @peculiar/x509; must load before it
import * as x509 from "@peculiar/x509"
import { webcrypto, X509Certificate as NodeX509, createPrivateKey } from "node:crypto"
import { isIP } from "node:net"

// MAW's private certificate authority (CA) — pure functions, no database.
//
// Trust model (MAW Phase 1 plan):
//   - One CA (ECDSA P-256), 10 years. Signs everything below.
//   - MAW's client certificate, CN "maw": what MAW presents to agents.
//   - One server certificate per machine, CN = machine id, alternative name
//     = the machine's address. The agent presents it; MAW accepts it only
//     if it chains to the CA AND its fingerprint equals the one stored
//     for that machine.
//
// Storing the CA (keys encrypted with lib/crypto.ts) is lib/pki-store.ts
// (step 05). Certificates are created here with @peculiar/x509 because
// Node can read certificates but not create them.

x509.cryptoProvider.set(webcrypto as unknown as Crypto)

const ALG: EcKeyGenParams & EcdsaParams = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" }
const CA_YEARS = 10
const CERT_YEARS = 10

export const CA_NAME = "CN=MAW CA, O=MAW"
export const CLIENT_CN = "maw"

export type CertAndKey = { certPem: string; keyPem: string }
export type Pki = { ca: CertAndKey; client: CertAndKey }
export type IssuedAgentCert = CertAndKey & { fingerprint: string; notAfter: Date }

function yearsFromNow(years: number): Date {
  const d = new Date()
  d.setUTCFullYear(d.getUTCFullYear() + years)
  return d
}

// A minute in the past so a machine whose clock is slightly behind still
// accepts a certificate issued just now.
function notBefore(): Date {
  return new Date(Date.now() - 60_000)
}

async function newKeys(): Promise<CryptoKeyPair> {
  return (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair
}

async function keyToPem(key: CryptoKey): Promise<string> {
  const der = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", key))
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd()
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`
}

async function pemToKey(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "")
  return webcrypto.subtle.importKey("pkcs8", Buffer.from(b64, "base64"), ALG, false, ["sign"])
}

function certToPem(cert: x509.X509Certificate): string {
  return cert.toString("pem").trimEnd() + "\n"
}

/** SHA-256 fingerprint in Node's format ("AB:CD:…"), the same format as
 *  tls getPeerCertificate().fingerprint256, so the two compare directly. */
export function fingerprintOf(certPem: string): string {
  return new NodeX509(certPem).fingerprint256
}

/** Creates the CA and MAW's client certificate. Called once, when no CA exists. */
export async function createPki(): Promise<Pki> {
  const caKeys = await newKeys()
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    name: CA_NAME,
    notBefore: notBefore(),
    notAfter: yearsFromNow(CA_YEARS),
    signingAlgorithm: ALG,
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  })

  const clientKeys = await newKeys()
  const clientCert = await x509.X509CertificateGenerator.create({
    subject: `CN=${CLIENT_CN}`,
    issuer: caCert.subject,
    notBefore: notBefore(),
    notAfter: yearsFromNow(CERT_YEARS),
    signingAlgorithm: ALG,
    publicKey: clientKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth]),
      await x509.SubjectKeyIdentifierExtension.create(clientKeys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caCert),
    ],
  })

  return {
    ca: { certPem: certToPem(caCert), keyPem: await keyToPem(caKeys.privateKey) },
    client: { certPem: certToPem(clientCert), keyPem: await keyToPem(clientKeys.privateKey) },
  }
}

/** Issues a machine's server certificate. Its key is returned for the
 *  install file and must not be stored. */
export async function issueAgentCert(
  ca: CertAndKey,
  machineId: string,
  address: string,
): Promise<IssuedAgentCert> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(machineId)) throw new Error("Invalid machine id.")
  const addr = address.trim()
  if (!addr) throw new Error("Address is required.")

  const caCert = new x509.X509Certificate(ca.certPem)
  const caKey = await pemToKey(ca.keyPem)
  const keys = await newKeys()
  const notAfter = yearsFromNow(CERT_YEARS)

  const san: x509.JsonGeneralName[] = isIP(addr)
    ? [{ type: "ip", value: addr }]
    : [{ type: "dns", value: addr }]

  const cert = await x509.X509CertificateGenerator.create({
    subject: `CN=${machineId}`,
    issuer: caCert.subject,
    notBefore: notBefore(),
    notAfter,
    signingAlgorithm: ALG,
    publicKey: keys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(san),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caCert),
    ],
  })

  const certPem = certToPem(cert)
  const keyPem = await keyToPem(keys.privateKey)
  // Same check Node's TLS layer will do: the key belongs to the certificate.
  if (!new NodeX509(certPem).checkPrivateKey(createPrivateKey(keyPem))) {
    throw new Error("Issued key does not match its certificate.")
  }
  return { certPem, keyPem, fingerprint: fingerprintOf(certPem), notAfter }
}
