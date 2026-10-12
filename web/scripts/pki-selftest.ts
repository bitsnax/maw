/**
 * Self-test for lib/pki.ts. Prints PASS or exits 1. Needs no database.
 *
 * Issues a CA, MAW's client certificate and two machine certificates, checks
 * them with Node's own X.509 code, then runs real mutual-TLS handshakes the
 * way MAW and maw-agent will (agent = server, MAW = client).
 *
 * Run from /opt/maw:
 *   docker compose run --rm --no-deps migrate npx tsx scripts/pki-selftest.ts
 */

import { X509Certificate, createPrivateKey } from "node:crypto"
import https from "node:https"
import type { AddressInfo } from "node:net"
import type { TLSSocket } from "node:tls"
import { createPki, issueAgentCert, fingerprintOf, CLIENT_CN } from "../lib/pki"

let failed = 0
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`)
  if (!ok) failed++
}

type Result = { ok: true; body: string } | { ok: false; error: string }

// Agent side: require a client certificate from MAW's CA with CN "maw".
function startAgent(cert: string, key: string, ca: string): Promise<https.Server> {
  const server = https.createServer({ cert, key, ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    const peer = (req.socket as TLSSocket).getPeerCertificate()
    if (peer.subject?.CN !== CLIENT_CN) { res.writeHead(403).end("not maw"); return }
    res.writeHead(200).end("agent ok")
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

// MAW side: trust the CA, and accept the agent only if its fingerprint is the stored one.
function callAgent(port: number, opts: { cert?: string; key?: string; ca: string; pin: string }): Promise<Result> {
  return new Promise((resolve) => {
    const req = https.request({
      host: "127.0.0.1", port, path: "/v1/info", method: "GET",
      cert: opts.cert, key: opts.key, ca: opts.ca, timeout: 5000,
      // A fresh connection per call: a pooled one would skip the handshake,
      // and with it the fingerprint check (lib/agent-client.ts must do the same
      // or keep one pool per machine fingerprint).
      agent: false,
      checkServerIdentity: (_host, peer) =>
        peer.fingerprint256 === opts.pin ? undefined : new Error("fingerprint mismatch"),
    }, (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => resolve(res.statusCode === 200 ? { ok: true, body } : { ok: false, error: `HTTP ${res.statusCode}` }))
    })
    req.on("error", (e) => resolve({ ok: false, error: e.message }))
    req.on("timeout", () => { req.destroy(new Error("timeout")) })
    req.end()
  })
}

async function main() {
  console.log("certificates")
  const pki = await createPki()
  const ca = new X509Certificate(pki.ca.certPem)
  const client = new X509Certificate(pki.client.certPem)
  const year9 = Date.now() + 9 * 365 * 86400_000

  check("CA is a CA, self-signed", ca.ca && ca.verify(ca.publicKey))
  check("CA valid for 10 years", new Date(ca.validTo).getTime() > year9)
  check("CA key matches CA certificate", ca.checkPrivateKey(createPrivateKey(pki.ca.keyPem)))
  check("client certificate signed by the CA", client.verify(ca.publicKey) && client.checkIssued(ca))
  check("client certificate CN is maw, not a CA", client.subject.includes(`CN=${CLIENT_CN}`) && !client.ca)

  const ipCert = await issueAgentCert(pki.ca, "gpubox01", "192.168.4.201")
  const dnsCert = await issueAgentCert(pki.ca, "cawbox01", "caw-box.lan.arpa")
  const ip = new X509Certificate(ipCert.certPem)
  const dns = new X509Certificate(dnsCert.certPem)
  check("machine certificate signed by the CA", ip.verify(ca.publicKey) && ip.checkIssued(ca))
  check("machine certificate CN is the machine id", ip.subject.includes("CN=gpubox01"))
  check("IP address in alternative name", ip.checkIP("192.168.4.201") === "192.168.4.201")
  check("host name in alternative name", dns.checkHost("caw-box.lan.arpa") === "caw-box.lan.arpa")
  check("fingerprint matches the certificate", ipCert.fingerprint === fingerprintOf(ipCert.certPem))
  check("two machines get different keys", ipCert.fingerprint !== dnsCert.fingerprint)
  check("machine certificate valid for 10 years", ipCert.notAfter.getTime() > year9)

  const other = await createPki()
  check("another CA's certificate does not verify", !new X509Certificate(other.client.certPem).verify(ca.publicKey))

  let threw = false
  try { await issueAgentCert(pki.ca, "bad id!", "192.168.4.201") } catch { threw = true }
  check("invalid machine id refused", threw)

  console.log("mutual TLS (agent = server, MAW = client)")
  const agent = await startAgent(ipCert.certPem, ipCert.keyPem, pki.ca.certPem)
  const port = (agent.address() as AddressInfo).port
  const good = { cert: pki.client.certPem, key: pki.client.keyPem, ca: pki.ca.certPem, pin: ipCert.fingerprint }

  const r1 = await callAgent(port, good)
  check("MAW with its client certificate is accepted", r1.ok && r1.body === "agent ok")
  const r2 = await callAgent(port, { ca: pki.ca.certPem, pin: ipCert.fingerprint })
  check("a caller without a client certificate is refused", !r2.ok)
  const r3 = await callAgent(port, { cert: other.client.certPem, key: other.client.keyPem, ca: pki.ca.certPem, pin: ipCert.fingerprint })
  check("a client certificate from another CA is refused", !r3.ok)
  const r4 = await callAgent(port, { ...good, pin: dnsCert.fingerprint })
  check("MAW refuses an agent whose fingerprint is not the stored one", !r4.ok && r4.error.includes("fingerprint"))
  const r5 = await callAgent(port, { ...good, ca: other.ca.certPem })
  check("MAW refuses an agent from another CA", !r5.ok)
  agent.close()

  console.log(failed === 0 ? "PASS" : `FAIL (${failed})`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
