// maw-agent — answers MAW, and only MAW, over mutual TLS.
//
// Every connection must present a client certificate signed by MAW's CA
// (MAW_CA_PEM) with CN "maw"; anything else is refused during the TLS
// handshake or with 403. MAW in turn accepts this agent only if its
// certificate's fingerprint is the one stored for the machine.
//
// Phase 1 API (JSON):
//   GET /v1/info   agent, host and Docker summary
// (containers and their actions arrive in step 04)

import https from "node:https"
import os from "node:os"
import { readFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { TLSSocket } from "node:tls"
import { loadConfig, type Config } from "./config.js"
import { dockerRequest, DockerError, type DockerInfo, type DockerVersion } from "./docker.js"

const CLIENT_CN = "maw"
const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version
const startedAt = Date.now()

type Json = Record<string, unknown>
type Handler = (cfg: Config, req: IncomingMessage) => Promise<{ status?: number; body: Json }>

function send(res: ServerResponse, status: number, body: Json) {
  const text = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) })
  res.end(text)
}

const info: Handler = async (cfg) => {
  const agent = { id: cfg.id, version: VERSION, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), runAs: cfg.runAs || null }
  try {
    const [d, v] = await Promise.all([
      dockerRequest<DockerInfo>(cfg.dockerSocket, "GET", "/info"),
      dockerRequest<DockerVersion>(cfg.dockerSocket, "GET", "/version"),
    ])
    return {
      body: {
        ok: true,
        agent,
        host: { hostname: d.Name, os: d.OperatingSystem, kernel: d.KernelVersion, cpus: d.NCPU, memoryBytes: d.MemTotal },
        docker: {
          version: v.Version, apiVersion: v.ApiVersion,
          containers: d.Containers, running: d.ContainersRunning, stopped: d.ContainersStopped, paused: d.ContainersPaused,
        },
      },
    }
  } catch (e) {
    // The agent itself is up; say so, and say why Docker is not.
    return {
      body: {
        ok: true,
        agent,
        host: { hostname: os.hostname(), os: `${os.type()} ${os.release()}`, kernel: os.release(), cpus: os.cpus().length, memoryBytes: os.totalmem() },
        docker: null,
        dockerError: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

const routes: Record<string, Handler> = {
  "GET /v1/info": info,
}

export function createAgentServer(cfg: Config): https.Server {
  return https.createServer(
    { cert: cfg.certPem, key: cfg.keyPem, ca: cfg.caPem, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" },
    async (req, res) => {
      const t0 = Date.now()
      const path = (req.url ?? "/").split("?")[0]
      let status = 500
      try {
        const peer = (req.socket as TLSSocket).getPeerCertificate()
        if (peer?.subject?.CN !== CLIENT_CN) {
          status = 403
          send(res, status, { ok: false, message: "Only MAW may call this agent." })
          return
        }
        const handler = routes[`${req.method} ${path}`]
        if (!handler) {
          status = 404
          send(res, status, { ok: false, message: `No such endpoint: ${req.method} ${path}` })
          return
        }
        const out = await handler(cfg, req)
        status = out.status ?? 200
        send(res, status, out.body)
      } catch (e) {
        status = e instanceof DockerError && e.status ? e.status : 500
        send(res, status, { ok: false, message: e instanceof Error ? e.message : String(e) })
      } finally {
        console.log(`${new Date().toISOString()} ${req.method} ${path} ${status} ${Date.now() - t0}ms`)
      }
    },
  )
}

// One readable line for the log instead of OpenSSL's multi-line text.
function refusalReason(e: Error): string {
  const m = e.message
  if (m.includes("peer did not return a certificate")) return "no client certificate"
  if (/unknown ca|certificate verify failed|bad certificate|socket hang up|ECONNRESET/i.test(m)) return "client certificate not accepted"
  if (/wrong version number|http request/i.test(m)) return "not a TLS connection"
  return m.split("\n")[0]!.trim()
}

// Started directly (node dist/server.js), not when imported by a test.
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  let cfg: Config
  try {
    cfg = loadConfig()
  } catch (e) {
    console.error(`maw-agent ${VERSION}: ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
  const server = createAgentServer(cfg)
  server.on("tlsClientError", (e, socket) => {
    console.log(`${new Date().toISOString()} refused ${socket.remoteAddress ?? "unknown address"}: ${refusalReason(e)}`)
  })
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(`maw-agent ${VERSION}: ${e.code === "EADDRINUSE" ? `port ${cfg.port} is already in use` : e.message}`)
    process.exit(1)
  })
  server.listen(cfg.port, "0.0.0.0", () => {
    console.log(`maw-agent ${VERSION} for ${cfg.id} listening on :${cfg.port}`)
  })
  const stop = () => server.close(() => process.exit(0))
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}
