"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { dashboardSnapshot, type DashSession, type DashSnapshot } from "./dashboard-actions"

// Sessions working now (asked again every 5 s while the tab is visible),
// then recent sessions. Each links to its session page.

const EVERY = 5000

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`
}
function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
}

export default function DashboardLive({ initial }: { initial: DashSnapshot }) {
  const [snap, setSnap] = useState(initial)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (!document.hidden) {
        try { const s = await dashboardSnapshot(); if (!stopped) setSnap(s) } catch { /* next tick */ }
      }
      if (!stopped) timer = setTimeout(tick, EVERY)
    }
    timer = setTimeout(tick, EVERY)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => { stopped = true; if (timer) clearTimeout(timer); clearInterval(clock) }
  }, [])

  if (!snap.ok) return <p className="app-empty">{snap.message}</p>

  return (
    <>
      {snap.unreachable && <div className="form-alert spaced">maw-opencode did not answer: {snap.unreachable}</div>}

      <h2 className="section-title">Working now</h2>
      {snap.active.length === 0 ? (
        <p className="app-empty">Nothing is running. Start a session from a project; it shows here while the model works.</p>
      ) : (
        <div className="dash-active">
          {snap.active.map((s) => <ActiveCard key={s.id} s={s} now={now} />)}
        </div>
      )}

      <h2 className="section-title">Recent sessions</h2>
      {snap.recent.length === 0 ? (
        <p className="app-empty">No sessions yet.</p>
      ) : (
        <table className="data-table">
          <thead><tr><th>Session</th><th>Project</th><th>Last prompt</th><th>By</th></tr></thead>
          <tbody>
            {snap.recent.map((s) => (
              <tr key={s.id}>
                <td><Link href={`/projects/${s.projectId}/sessions/${s.id}`} className="data-link">{s.title}</Link></td>
                <td><Link href={`/projects/${s.projectId}`} className="data-link">{s.projectName}</Link> <span className="dash-muted">on {s.machineName}</span></td>
                <td className="data-nowrap">{when(s.updatedAt)}</td>
                <td>{s.user ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function ActiveCard({ s, now }: { s: DashSession; now: number }) {
  const l = s.live!
  const label = l.state === "waiting" ? "Waiting for you" : l.state === "retry" ? "Retrying" : `Working · ${l.since ? ago(l.since, now) : "…"}`
  return (
    <Link href={`/projects/${s.projectId}/sessions/${s.id}`} className={`dash-card is-${l.state}`}>
      <div className="dash-card-head">
        <span className="dash-card-title">{s.title}</span>
        <span className={`dash-state is-${l.state}`}>{label}</span>
      </div>
      <div className="dash-card-meta">{s.projectName} on {s.machineName}{s.user ? ` · ${s.user}` : ""}</div>
      <div className="dash-card-activity data-mono">{l.activity}</div>
      {l.message && <div className="dash-card-note">{l.message}</div>}
    </Link>
  )
}
