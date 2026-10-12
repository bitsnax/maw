"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState, useTransition } from "react"
import { containerAction, containerLogs } from "../actions"
import type { ContainerRow, ContainerActionName, LogsResult } from "@/lib/machines"

// Containers grouped by Compose project, like Dozzle. Stop and Restart ask
// for confirmation in the row; Start does not. While an action runs the row
// says so (Stop and Restart can take up to 10 seconds: Docker waits for a
// clean exit before it forces one).

const VERB: Record<ContainerActionName, { label: string; doing: string }> = {
  start: { label: "Start", doing: "Starting…" },
  stop: { label: "Stop", doing: "Stopping…" },
  restart: { label: "Restart", doing: "Restarting…" },
}

type Pending = { name: string; action: ContainerActionName }

export default function Containers({ machineId, containers }: { machineId: string; containers: ContainerRow[] }) {
  const router = useRouter()
  const [confirm, setConfirm] = useState<Pending | null>(null)
  const [running, setRunning] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const groups = new Map<string, ContainerRow[]>()
  for (const c of containers) {
    const key = c.project ?? ""
    groups.set(key, [...(groups.get(key) ?? []), c])
  }
  const order = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))

  async function run(p: Pending) {
    setConfirm(null)
    setRunning(p)
    setNotice(null)
    const r = await containerAction(machineId, p.name, p.action)
    setRunning(null)
    setNotice(
      r.ok
        ? { ok: true, text: r.data.changed ? `${p.name} is now ${r.data.state}.` : `${p.name} was already ${r.data.state}.` }
        : { ok: false, text: r.message },
    )
    startTransition(() => router.refresh())
  }

  return (
    <>
      {notice && <div className={`form-alert${notice.ok ? " form-alert-info" : ""} spaced`}>{notice.text}</div>}

      <div className="container-groups">
        {order.map((project) => (
          <section key={project || "(none)"} className="container-group">
            <h3 className="container-group-title">
              {project || "Not in a Compose project"}
              <span className="container-group-count">{groups.get(project)!.length}</span>
            </h3>
            <ul className="container-list">
              {groups.get(project)!.map((c) => {
                const isRunning = c.state === "running"
                const busy = running?.name === c.name
                const asking = confirm?.name === c.name
                return (
                  <li key={c.id} className="container-row">
                    <span className={`status-dot ${isRunning ? "is-online" : "is-offline"}`} aria-hidden="true" />
                    <div className="container-main">
                      <div className="container-name">
                        {c.name}
                        {c.self && <span className="tag">This agent</span>}
                      </div>
                      <div className="container-meta">
                        <span className="data-mono">{c.image}</span>
                        <span>{busy ? VERB[running!.action].doing : c.status}</span>
                      </div>
                    </div>
                    <div className="container-actions">
                      {asking ? (
                        <>
                          <span className="container-ask">{VERB[confirm!.action].label} {c.name}?</span>
                          <button type="button" className="btn btn-small btn-danger" onClick={() => run(confirm!)}>
                            {VERB[confirm!.action].label}
                          </button>
                          <button type="button" className="btn btn-small" onClick={() => setConfirm(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          {!isRunning && (
                            <button type="button" className="btn btn-small" disabled={!!running}
                              onClick={() => run({ name: c.name, action: "start" })}>Start</button>
                          )}
                          {isRunning && !c.self && (
                            <>
                              <button type="button" className="btn btn-small" disabled={!!running}
                                onClick={() => setConfirm({ name: c.name, action: "restart" })}>Restart</button>
                              <button type="button" className="btn btn-small" disabled={!!running}
                                onClick={() => setConfirm({ name: c.name, action: "stop" })}>Stop</button>
                            </>
                          )}
                          <button type="button" className="btn btn-small"
                            onClick={() => setLogsFor(logsFor === c.name ? null : c.name)}>
                            {logsFor === c.name ? "Hide logs" : "Logs"}
                          </button>
                        </>
                      )}
                    </div>
                    {logsFor === c.name && <Logs machineId={machineId} name={c.name} />}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </>
  )
}

function Logs({ machineId, name }: { machineId: string; name: string }) {
  type State =
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "done"; data: LogsResult }
  const [state, setState] = useState<State>({ status: "loading" })

  const apply = (r: Awaited<ReturnType<typeof containerLogs>>) =>
    setState(r.ok ? { status: "done", data: r.data } : { status: "error", message: r.message })

  // First load when the panel opens: state starts as loading and is set only
  // in the promise callback, never synchronously in the effect.
  useEffect(() => {
    let cancelled = false
    containerLogs(machineId, name, 200).then((r) => { if (!cancelled) apply(r) })
    return () => { cancelled = true }
  }, [machineId, name])

  async function refresh() {
    setState({ status: "loading" })
    apply(await containerLogs(machineId, name, 200))
  }

  return (
    <div className="logs-panel">
      <div className="logs-head">
        <span>Last 200 lines</span>
        <button type="button" className="btn btn-small" onClick={refresh} disabled={state.status === "loading"}>
          {state.status === "loading" ? "Loading…" : "Refresh"}
        </button>
      </div>
      {state.status === "error" && <div className="form-alert">{state.message}</div>}
      {state.status === "done" && (
        state.data.lines.length === 0 ? (
          <p className="app-empty">No log lines.</p>
        ) : (
          <pre className="logs-body">
            {state.data.lines.map((l, i) => (
              <div key={i} className={l.stream === "stderr" ? "log-err" : undefined}>
                <span className="log-time">{l.time ? l.time.slice(11, 19) : "        "}</span> {l.text}
              </div>
            ))}
          </pre>
        )
      )}
    </div>
  )
}
