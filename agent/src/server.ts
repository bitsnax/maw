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
//   POST /v1/fs/read   {root, path, offset?, limit?}     numbered text lines
//   POST /v1/fs/list   {root, path?}                     folder entries
//   POST /v1/fs/write  {root, path, content}             create or replace a file
//   POST /v1/fs/edit   {root, path, oldString, newString, replaceAll?}
//   POST /v1/fs/glob   {root, pattern, path?, limit?}    file paths, newest first (max 1,000)
//   POST /v1/fs/search {root, pattern, path?, include?, ignoreCase?, limit?}  file, line, text (max 500)
//   POST /v1/exec      {root, command, timeoutSeconds?}  start a command on the host → job
//   GET  /v1/exec                          jobs (running, and ended within the hour)
//   GET  /v1/exec/:id?tail=N               state, exit code, duration, last N lines (default 200)
//   GET  /v1/exec/:id/stream?after=SEQ     NDJSON: kept lines, live lines, then the end
//   POST /v1/exec/:id/stop                 end it and everything it started (TERM, KILL after 5 s)
// :ref is a container name or id. The agent's own container cannot be
// stopped or restarted from MAW. File paths are confined to the root, and
// every root to the allowed base (guard.ts); see fs.ts for the file rules
// and exec.ts for how commands run.

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
import { fsRead, fsList, fsWrite, fsEdit, type FsOptions } from "./fs.js"
import { fsGlob, fsSearch } from "./search.js"
import { ExecManager, checkCommands, type JobEvent } from "./exec.js"

const CLIENT_CN = "maw"
const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version
const startedAt = Date.now()

// Read once at start (see host.ts); reported by /v1/info.
let identity: HostIdentity = { ok: false, user: "", error: "not read yet" }
let ripgrep: string | null = null
let commands: { ok: boolean; ms?: number; error?: string } = { ok: false, error: "not checked yet" }
export function hostIdentity(): HostIdentity { return identity }

// One per agent; created with the server (tests make their own).
let exec: ExecManager | null = null

type Json = Record<string, unknown>
type Ctx = { cfg: Config; req: IncomingMessage; params: string[]; query: URLSearchParams; body: () => Promise<Json> }

// Request bodies: JSON objects only, at most 5 MB (a 4 MB file plus JSON escaping).
const MAX_BODY_BYTES = 5 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on("data", (c: Buffer) => {
      if (failed) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        failed = true
        reject(new HttpError(413, "Request body is over 5 MB."))
        return
      }
      chunks.push(c)
    })
    req.on("error", (e) => { if (!failed) { failed = true; reject(e) } })
    req.on("end", () => {
      if (failed) return
      const text = Buffer.concat(chunks).toString("utf8")
      if (text.trim() === "") return resolve({})
      try {
        const v: unknown = JSON.parse(text)
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error()
        resolve(v as Json)
      } catch {
        reject(new HttpError(400, "Request body must be a JSON object."))
      }
    })
  })
}

const fsOpts = (cfg: Config): FsOptions => ({ base: cfg.allowedBase, identity })
// A handler answers with JSON, or takes over the response (a stream).
type Handler = (ctx: Ctx) => Promise<{ status?: number; body: Json } | { stream: (res: ServerResponse) => void }>

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
    commands,
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
  { method: "POST", path: /^\/v1\/fs\/read$/, handler: async ({ cfg, body }) => ({ body: { ok: true, ...fsRead(fsOpts(cfg), await body()) } }) },
  { method: "POST", path: /^\/v1\/fs\/list$/, handler: async ({ cfg, body }) => ({ body: { ok: true, ...fsList(fsOpts(cfg), await body()) } }) },
  { method: "POST", path: /^\/v1\/fs\/write$/, handler: async ({ cfg, body }) => ({ body: { ok: true, ...fsWrite(fsOpts(cfg), await body()) } }) },
  { method: "POST", path: /^\/v1\/fs\/edit$/, handler: async ({ cfg, body }) => ({ body: { ok: true, ...fsEdit(fsOpts(cfg), await body()) } }) },
  { method: "POST", path: /^\/v1\/fs\/glob$/, handler: async ({ cfg, body }) => ({ body: { ok: true, ...(await fsGlob({ base: cfg.allowedBase }, await body())) } }) },
  { method: "POST", path: /^\/v1\/fs\/search$/, handler: async ({ cfg, body }) => ({ body: { ok: true, ...(await fsSearch({ base: cfg.allowedBase }, await body())) } }) },
  { method: "POST", path: /^\/v1\/exec$/, handler: async ({ body }) => {
    const job = jobs().start(await body())
    return { body: { ok: true, jobId: job.id, ...job } }
  } },
  { method: "GET", path: /^\/v1\/exec$/, handler: async () => ({ body: { ok: true, jobs: jobs().list() } }) },
  { method: "GET", path: /^\/v1\/exec\/([0-9a-f]{16})$/, handler: async ({ params, query }) =>
    ({ body: { ok: true, ...jobs().describe(params[0]!, query.get("tail")) } }) },
  { method: "POST", path: /^\/v1\/exec\/([0-9a-f]{16})\/stop$/, handler: async ({ params }) =>
    ({ body: { ok: true, ...(await jobs().stop(params[0]!)) } }) },
  { method: "GET", path: /^\/v1\/exec\/([0-9a-f]{16})\/stream$/, handler: async ({ params, query }) => {
    const after = query.get("after") === null ? 0 : Number(query.get("after"))
    if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "after must be a whole number ≥ 0.")
    const id = params[0]!
    jobs().get(id) // 404 before the stream starts
    return { stream: (res) => streamJob(res, id, after) }
  } },
]

function jobs(): ExecManager {
  if (!exec) throw new HttpError(503, "Commands are not set up in this agent.")
  return exec
}

// NDJSON, one event per line:
//   {"type":"line","seq":1,"t":<ms>,"stream":"stdout","text":"..."}
//   {"type":"skipped","count":N}     lines older than the kept 2,000
//   {"type":"ping"}                  every 15 s while nothing happens
//   {"type":"end", ...status}        last line; then the response ends
function streamJob(res: ServerResponse, id: string, after: number) {
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" })
  const write = (o: Json) => { if (!res.writableEnded) res.write(JSON.stringify(o) + "\n") }
  let ping: NodeJS.Timeout | null = null
  const done = () => { if (ping) clearInterval(ping); if (!res.writableEnded) res.end() }
  const on = (e: JobEvent) => {
    if (e.type === "line") write({ type: "line", ...e.line })
    else { write({ type: "end", ...e.status }); done() }
  }
  const sub = jobs().subscribe(id, after, on)
  if (sub.skipped > 0) write({ type: "skipped", count: sub.skipped })
  for (const l of sub.lines) write({ type: "line", ...l })
  if (sub.ended) { write({ type: "end", ...sub.ended }); done(); return }
  ping = setInterval(() => write({ type: "ping" }), 15000)
  res.on("close", () => { sub.off(); if (ping) clearInterval(ping) })
}

export function createAgentServer(cfg: Config): https.Server {
  exec = new ExecManager({ base: cfg.allowedBase, identity: () => identity })
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
        const out = await route.handler({
          cfg, req, params: (match as RegExpExecArray).slice(1), query: url.searchParams, body: () => readBody(req),
        })
        if ("stream" in out) {
          status = 200
          out.stream(res)
          return
        }
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
  void checkCommands(identity).then((r) => {
    commands = r
    console.log(r.ok
      ? `maw-agent ${VERSION}: host commands work (${r.ms} ms as ${identity.user})`
      : `maw-agent ${VERSION}: host commands do not work: ${r.error}`)
  })
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
  const stop = () => {
    exec?.stopAll()
    server.close(() => process.exit(0))
    // Open streams would keep close() waiting.
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
}
