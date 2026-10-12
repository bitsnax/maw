// Docker Engine API over the mounted socket, with Node's own http module.
// Unversioned paths: the daemon answers in its own API version.

import http from "node:http"

export class DockerError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

export function dockerRequest<T>(
  socketPath: string,
  method: string,
  path: string,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        const status = res.statusCode ?? 0
        if (status >= 400) {
          let message = text
          try { message = (JSON.parse(text) as { message?: string }).message ?? text } catch { /* plain text */ }
          reject(new DockerError(message.trim() || `Docker answered ${status}`, status))
          return
        }
        if (!text) { resolve(undefined as T); return }
        try { resolve(JSON.parse(text) as T) } catch { reject(new DockerError("Docker sent an answer that is not JSON")) }
      })
    })
    req.on("timeout", () => req.destroy(new DockerError("Docker did not answer in time")))
    req.on("error", (e) => reject(e instanceof DockerError ? e : new DockerError(`Docker is not reachable: ${e.message}`)))
    req.end()
  })
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
