// maw-agent — answers MAW, and only MAW, over mutual TLS.
//
// Every connection must present a client certificate signed by MAW's CA
// (MAW_CA_PEM) with CN "maw"; anything else is refused during the TLS
// handshake or with 403. MAW in turn accepts this agent only if its
// certificate's fingerprint is the one stored for the machine.
//
// API (JSON; errors are { ok: false, message }):
//   GET  /v1/info                          agent, host and Docker summary
//   GET  /v1/containers                    every container, grouped by Compose project
//   POST /v1/containers/:ref/start|stop|restart
//   GET  /v1/containers/:ref/logs?tail=N   last N lines (default 200, max 2000)
// :ref is a container name or id. The agent's own container cannot be
// stopped or restarted from MAW.

import https from "node:https"
import os from "node:os"
import { readFileSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { TLSSocket } from "node:tls"
import { loadConfig, type Config } from "./config.js"
import { dockerRequest, DockerError, type DockerInfo, type DockerVersion } from "./docker.js"
import { listContainers, containerAction, containerLogs, HttpError, type Action } from "./containers.js"
import { readHostIdentity, ripgrepVersion, type HostIdentity } from "./host.js"
import { GuardError } from "./guard.js"

const CLIENT_CN = "maw"
const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version
const startedAt = Date.now()

// Read once at start (see host.ts); reported by /v1/info.
let identity: HostIdentity = { ok: false, user: "", error: "not read yet" }
let ripgrep: string | null = null
export function hostIdentity(): HostIdentity { return identity }

type Json = Record<string, unknown>
type Ctx = { cfg: Config; req: IncomingMessage; params: string[]; query: URLSearchParams }
type Handler = (ctx: Ctx) => Promise<{ status?: number; body: Json }>

function send(res: ServerResponse, status: number, body: Json) {
  const text = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) })
  res.end(text)
}

const info: Handler = async ({ cfg }) => {
  const agent = {
    id: cfg.id, version: VERSION, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), runAs: cfg.runAs || null,
    allowedBase: cfg.allowedBase,
    hostUser: identity.ok
      ? { ok: true, user: identity.user, uid: identity.uid, gid: identity.gid, home: identity.home, lang: identity.lang }
      : { ok: false, user: identity.user, error: identity.error },
    ripgrep,
  }
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

const routes: { method: string; path: RegExp; handler: Handler }[] = [
  { method: "GET", path: /^\/v1\/info$/, handler: info },
  {
    method: "GET", path: /^\/v1\/containers$/,
    handler: async ({ cfg }) => ({ body: { ok: true, containers: await listContainers(cfg) } }),
  },
  {
    method: "POST", path: /^\/v1\/containers\/([^/]+)\/(start|stop|restart)$/,
    handler: async ({ cfg, params }) =>
      ({ body: { ok: true, ...(await containerAction(cfg, decodeURIComponent(params[0]!), params[1] as Action)) } }),
  },
  {
    method: "GET", path: /^\/v1\/containers\/([^/]+)\/logs$/,
    handler: async ({ cfg, params, query }) =>
      ({ body: { ok: true, ...(await containerLogs(cfg, decodeURIComponent(params[0]!), query.get("tail"))) } }),
  },
]

export function createAgentServer(cfg: Config): https.Server {
  return https.createServer(
    { cert: cfg.certPem, key: cfg.keyPem, ca: cfg.caPem, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" },
    async (req, res) => {
      const t0 = Date.now()
      const url = new URL(req.url ?? "/", "https://agent")
      const path = url.pathname
      let status = 500
      try {
        const peer = (req.socket as TLSSocket).getPeerCertificate()
        if (peer?.subject?.CN !== CLIENT_CN) {
          status = 403
          send(res, status, { ok: false, message: "Only MAW may call this agent." })
          return
        }
        let match: RegExpExecArray | null = null
        const route = routes.find((r) => r.method === req.method && (match = r.path.exec(path)) !== null)
        if (!route || !match) {
          status = routes.some((r) => r.path.test(path)) ? 405 : 404
          send(res, status, { ok: false, message: `No such endpoint: ${req.method} ${path}` })
          return
        }
        const out = await route.handler({ cfg, req, params: (match as RegExpExecArray).slice(1), query: url.searchParams })
        status = out.status ?? 200
        send(res, status, out.body)
      } catch (e) {
        status = e instanceof HttpError || e instanceof GuardError ? e.status : e instanceof DockerError && e.status ? e.status : 500
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
  identity = readHostIdentity(cfg.runAs, cfg.hostRoot)
  ripgrep = ripgrepVersion()
  console.log(identity.ok
    ? `maw-agent ${VERSION}: runs as ${identity.user} (uid ${identity.uid}, gid ${identity.gid}, ${identity.home}, LANG ${identity.lang})`
    : `maw-agent ${VERSION}: host user not available: ${identity.error}`)
  console.log(`maw-agent ${VERSION}: ripgrep ${ripgrep ?? "not found"}`)
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
