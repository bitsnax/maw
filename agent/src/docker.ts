// Docker Engine API over the mounted socket, with Node's own http module.
// Unversioned paths: the daemon answers in its own API version.

import http from "node:http"

export class DockerError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

/** Raw request: status and body bytes. Docker's error JSON becomes a DockerError. */
export function dockerRaw(
  socketPath: string,
  method: string,
  path: string,
  timeoutMs = 10_000,
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => {
        const body = Buffer.concat(chunks)
        const status = res.statusCode ?? 0
        if (status >= 400) {
          const text = body.toString("utf8")
          let message = text
          try { message = (JSON.parse(text) as { message?: string }).message ?? text } catch { /* plain text */ }
          reject(new DockerError(message.trim() || `Docker answered ${status}`, status))
          return
        }
        resolve({ status, body })
      })
    })
    req.on("timeout", () => req.destroy(new DockerError("Docker did not answer in time")))
    req.on("error", (e) => reject(e instanceof DockerError ? e : new DockerError(`Docker is not reachable: ${e.message}`)))
    req.end()
  })
}

/** JSON request; an empty body (204, 304) resolves to undefined. */
export async function dockerRequest<T>(
  socketPath: string,
  method: string,
  path: string,
  timeoutMs = 10_000,
): Promise<T> {
  const { body } = await dockerRaw(socketPath, method, path, timeoutMs)
  if (body.length === 0) return undefined as T
  try {
    return JSON.parse(body.toString("utf8")) as T
  } catch {
    throw new DockerError("Docker sent an answer that is not JSON")
  }
}

export type DockerInfo = {
  Name: string
  OperatingSystem: string
  KernelVersion: string
  NCPU: number
  MemTotal: number
  Containers: number
  ContainersRunning: number
  ContainersStopped: number
  ContainersPaused: number
}

export type DockerVersion = { Version: string; ApiVersion: string }

export type DockerContainerSummary = {
  Id: string
  Names: string[]
  Image: string
  State: string
  Status: string
  Created: number
  Labels: Record<string, string> | null
}

export type DockerContainerInspect = {
  Id: string
  Name: string
  Config: { Tty: boolean; Hostname: string }
  State: { Status: string; StartedAt: string; FinishedAt: string }
}

export type LogLine = { time: string | null; stream: "stdout" | "stderr" | "tty"; text: string }

const MAX_LINE = 4000

function splitTime(line: string): { time: string | null; text: string } {
  // With timestamps=1 every line starts "2026-10-12T04:01:36.855123456Z ".
  const sp = line.indexOf(" ")
  if (sp > 0 && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(line.slice(0, sp))) {
    return { time: line.slice(0, sp), text: line.slice(sp + 1) }
  }
  return { time: null, text: line }
}

function toLines(text: string, stream: LogLine["stream"]): LogLine[] {
  return text
    .split("\n")
    .filter((l, i, all) => l.length > 0 || i < all.length - 1)
    .map((l) => {
      const { time, text: t } = splitTime(l.replace(/\r$/, ""))
      return { time, stream, text: t.length > MAX_LINE ? t.slice(0, MAX_LINE) + " …" : t }
    })
}

/**
 * Decodes a logs body. Without a TTY Docker multiplexes stdout and stderr in
 * frames: 8-byte header [stream, 0, 0, 0, size (big-endian uint32)] then the
 * payload. With a TTY the body is the raw text.
 */
export function decodeLogs(body: Buffer, tty: boolean): LogLine[] {
  if (tty) return toLines(body.toString("utf8"), "tty")
  const out: LogLine[] = []
  let pending: { stream: LogLine["stream"]; text: string } | null = null
  let i = 0
  while (i + 8 <= body.length) {
    const kind = body[i]
    const size = body.readUInt32BE(i + 4)
    const payload = body.subarray(i + 8, i + 8 + size).toString("utf8")
    i += 8 + size
    const stream: LogLine["stream"] = kind === 2 ? "stderr" : "stdout"
    // A line may be split across frames of the same stream; join them.
    if (pending && pending.stream === stream) pending.text += payload
    else {
      if (pending) out.push(...toLines(pending.text, pending.stream))
      pending = { stream, text: payload }
    }
    if (pending.text.endsWith("\n")) {
      out.push(...toLines(pending.text, pending.stream))
      pending = null
    }
  }
  if (pending) out.push(...toLines(pending.text, pending.stream))
  return out
}
