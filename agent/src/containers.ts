// Container endpoints: list, start / stop / restart, recent logs.

import os from "node:os"
import type { Config } from "./config.js"
import {
  dockerRaw, dockerRequest, decodeLogs, DockerError,
  type DockerContainerSummary, type DockerContainerInspect,
} from "./docker.js"

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export type ContainerRow = {
  id: string
  name: string
  image: string
  state: string
  status: string
  created: string
  project: string | null
  service: string | null
  self: boolean
}

// A container id (hex) or name. Names: Docker allows [a-zA-Z0-9][a-zA-Z0-9_.-]*.
const REF = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

export function checkRef(ref: string): string {
  if (!REF.test(ref)) throw new HttpError(400, "Not a container id or name.")
  return ref
}

// Inside a container the host name defaults to the first 12 characters of
// the container's id: that is how the agent recognizes its own container.
function isSelf(id: string): boolean {
  const h = os.hostname()
  return /^[0-9a-f]{12}$/.test(h) && id.startsWith(h)
}

async function inspect(cfg: Config, ref: string): Promise<DockerContainerInspect> {
  try {
    return await dockerRequest<DockerContainerInspect>(cfg.dockerSocket, "GET", `/containers/${encodeURIComponent(ref)}/json`)
  } catch (e) {
    if (e instanceof DockerError && e.status === 404) throw new HttpError(404, `No container named or with id "${ref}".`)
    throw e
  }
}

export async function listContainers(cfg: Config): Promise<ContainerRow[]> {
  const rows = await dockerRequest<DockerContainerSummary[]>(cfg.dockerSocket, "GET", "/containers/json?all=1")
  return rows
    .map((c) => {
      const labels = c.Labels ?? {}
      return {
        id: c.Id.slice(0, 12),
        name: (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
        image: c.Image,
        state: c.State,
        status: c.Status,
        created: new Date(c.Created * 1000).toISOString(),
        project: labels["com.docker.compose.project"] ?? null,
        service: labels["com.docker.compose.service"] ?? null,
        self: isSelf(c.Id),
      }
    })
    .sort((a, b) =>
      (a.project ?? "￿").localeCompare(b.project ?? "￿") || a.name.localeCompare(b.name))
}

export type Action = "start" | "stop" | "restart"

export async function containerAction(cfg: Config, ref: string, action: Action) {
  const c = await inspect(cfg, checkRef(ref))
  const name = c.Name.replace(/^\//, "")
  if (isSelf(c.Id) && action !== "start") {
    throw new HttpError(409, `${name} is this agent; ${action} it on the machine itself (docker compose in /opt/maw-agent).`)
  }
  // t=10: seconds Docker waits for a clean exit before it kills the process.
  const query = action === "start" ? "" : "?t=10"
  const { status } = await dockerRaw(cfg.dockerSocket, "POST", `/containers/${c.Id}/${action}${query}`, 30_000)
  const after = await inspect(cfg, c.Id)
  return {
    id: c.Id.slice(0, 12),
    name,
    action,
    changed: status !== 304, // 304: it was already in that state
    state: after.State.Status,
  }
}

export async function containerLogs(cfg: Config, ref: string, tailParam: string | null) {
  const tail = tailParam === null ? 200 : Number(tailParam)
  if (!Number.isInteger(tail) || tail < 1 || tail > 2000) throw new HttpError(400, "tail must be a whole number from 1 to 2000.")
  const c = await inspect(cfg, checkRef(ref))
  const { body } = await dockerRaw(
    cfg.dockerSocket, "GET",
    `/containers/${c.Id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`,
    20_000,
  )
  return {
    id: c.Id.slice(0, 12),
    name: c.Name.replace(/^\//, ""),
    state: c.State.Status,
    tail,
    lines: decodeLogs(body, c.Config.Tty),
  }
}
