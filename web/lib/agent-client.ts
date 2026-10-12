import https from "node:https"
import type { IncomingMessage } from "node:http"
import { getPki } from "./pki-store"
import type { Pki } from "./pki"

// Calls a machine's maw-agent over mutual TLS.
//
//   - MAW presents its client certificate (CN "maw").
//   - The agent must present a certificate from MAW's CA whose SHA-256
//     fingerprint equals the one stored for the machine. That fingerprint
//     check replaces host-name checking.
//   - agent: false = a fresh connection for every call. A pooled connection
//     would skip the handshake, and with it the fingerprint check (found by
//     the step 02 self-test).
//   - Never throws: every outcome is an AgentResult with a readable message.
//   - callAgent sends an optional JSON body and reads a JSON answer;
//     openAgentStream hands back the response itself for streamed answers
//     (a command's output), after the same handshake and checks.

export type AgentTarget = {
  name: string
  address: string
  port: number
  certFingerprint: string
}

export type AgentResult<T> =
  | { ok: true; data: T }
  | { ok: false; status?: number; message: string }

const FINGERPRINT_MISMATCH = "MAW_FINGERPRINT_MISMATCH"

function readable(e: NodeJS.ErrnoException, m: AgentTarget, timeoutMs: number): string {
  const where = `${m.address}:${m.port}`
  if (e.message === FINGERPRINT_MISMATCH) {
    return `The agent at ${where} is not the one paired as ${m.name} (its certificate does not match). Check the address, or reissue the certificate.`
  }
  switch (e.code) {
    case "ECONNREFUSED": return `Nothing is listening at ${where}. Is maw-agent running on ${m.name}?`
    case "EHOSTUNREACH":
    case "ENETUNREACH": return `${where} cannot be reached from MAW (no route to the machine).`
    case "ENOTFOUND":
    case "EAI_AGAIN": return `The name ${m.address} does not resolve.`
    case "ECONNRESET": return `The agent at ${where} closed the connection (it did not accept MAW's certificate).`
    case "ETIMEDOUT": return `${where} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "CERT_SIGNATURE_FAILURE":
      return `The agent at ${where} has a certificate that MAW did not issue.`
    case "CERT_HAS_EXPIRED": return `The agent's certificate on ${m.name} has expired. Reissue it.`
  }
  return `${m.name}: ${e.message}`
}

async function loadPki(): Promise<{ ok: true; pki: Pki } | { ok: false; message: string }> {
  try {
    return { ok: true, pki: await getPki() }
  } catch (e) {
    return { ok: false, message: `MAW's certificates are not available: ${e instanceof Error ? e.message : e}` }
  }
}

function requestOptions(m: AgentTarget, pki: Pki, method: string, path: string, timeoutMs: number, body: string | null, accept: string): https.RequestOptions {
  const headers: Record<string, string | number> = { accept }
  if (body !== null) {
    headers["content-type"] = "application/json"
    headers["content-length"] = Buffer.byteLength(body)
  }
  return {
    host: m.address,
    port: m.port,
    method,
    path,
    agent: false,
    cert: pki.client.certPem,
    key: pki.client.keyPem,
    ca: pki.ca.certPem,
    minVersion: "TLSv1.2",
    timeout: timeoutMs,
    headers,
    checkServerIdentity: (_host, cert) =>
      cert.fingerprint256 === m.certFingerprint ? undefined : new Error(FINGERPRINT_MISMATCH),
  }
}

/** The agent's error message from a JSON error body, or a readable fallback. */
function errorFrom(m: AgentTarget, status: number | undefined, text: string): string {
  try {
    const b = JSON.parse(text) as { message?: string }
    if (b.message) return b.message
  } catch { /* not JSON */ }
  return `${m.name} answered ${status}.`
}

export async function callAgent<T>(
  m: AgentTarget,
  method: "GET" | "POST",
  path: string,
  opts: { timeoutMs?: number; body?: unknown } = {},
): Promise<AgentResult<T>> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const p = await loadPki()
  if (!p.ok) return p
  const body = opts.body === undefined ? null : JSON.stringify(opts.body)

  return new Promise((resolve) => {
    let settled = false
    const done = (r: AgentResult<T>) => { if (!settled) { settled = true; resolve(r) } }

    const req = https.request(
      requestOptions(m, p.pki, method, path, timeoutMs, body, "application/json"),
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (c: string) => { text += c })
        res.on("end", () => {
          let body: { ok?: boolean; message?: string } & Record<string, unknown>
          try {
            body = JSON.parse(text)
          } catch {
            done({ ok: false, status: res.statusCode, message: `${m.name} sent an answer MAW cannot read.` })
            return
          }
          if (res.statusCode === 200 && body.ok) done({ ok: true, data: body as T })
          else done({ ok: false, status: res.statusCode, message: body.message ?? `${m.name} answered ${res.statusCode}.` })
        })
      },
    )
    req.on("timeout", () => {
      const e: NodeJS.ErrnoException = new Error("timeout")
      e.code = "ETIMEDOUT"
      req.destroy(e)
    })
    req.on("error", (e: NodeJS.ErrnoException) => done({ ok: false, message: readable(e, m, timeoutMs) }))
    req.end(body ?? undefined)
  })
}

/**
 * Opens a streamed GET (NDJSON) on the agent. On 200 the response is
 * returned unread; the caller reads it and must destroy it when done.
 * `idleMs` ends a stream that has been silent that long (the agent pings
 * every 15 s, so silence means it is gone).
 */
export async function openAgentStream(
  m: AgentTarget,
  path: string,
  opts: { idleMs?: number; signal?: AbortSignal } = {},
): Promise<AgentResult<IncomingMessage>> {
  const idleMs = opts.idleMs ?? 60_000
  const p = await loadPki()
  if (!p.ok) return p
  return new Promise((resolve) => {
    let settled = false
    const done = (r: AgentResult<IncomingMessage>) => { if (!settled) { settled = true; resolve(r) } }
    const req = https.request(requestOptions(m, p.pki, "GET", path, idleMs, null, "application/x-ndjson"), (res) => {
      if (res.statusCode === 200) {
        done({ ok: true, data: res })
        return
      }
      let text = ""
      res.setEncoding("utf8")
      res.on("data", (c: string) => { if (text.length < 8192) text += c })
      res.on("end", () => done({ ok: false, status: res.statusCode, message: errorFrom(m, res.statusCode, text) }))
    })
    req.on("timeout", () => {
      const e: NodeJS.ErrnoException = new Error("timeout")
      e.code = "ETIMEDOUT"
      req.destroy(e)
    })
    req.on("error", (e: NodeJS.ErrnoException) => done({ ok: false, message: readable(e, m, idleMs) }))
    opts.signal?.addEventListener("abort", () => req.destroy(), { once: true })
    req.end()
  })
}
