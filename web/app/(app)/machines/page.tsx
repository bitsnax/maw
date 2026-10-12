import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { getMachineInfo } from "@/lib/machines"

export const dynamic = "force-dynamic"

// Machines list. Asks every agent for /v1/info in parallel (3-second
// timeout each), so the dot reflects the machine right now.

function ago(d: Date | null): string {
  if (!d) return "never"
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}

export default async function MachinesPage() {
  const machines = await prisma.machine.findMany({ orderBy: { name: "asc" } })
  const checks = await Promise.all(machines.map((m) => getMachineInfo(m)))

  return (
    <>
      <div className="page-head">
        <h1 className="app-title">Machines</h1>
        <Link href="/machines/new" className="btn btn-primary">Add machine</Link>
      </div>

      {machines.length === 0 ? (
        <p className="app-empty">No machines yet. Add one to install its agent.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Address</th>
              <th>Host</th>
              <th>Agent</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {machines.map((m, i) => {
              const r = checks[i]!
              const seen = r.ok ? new Date() : m.lastSeenAt
              return (
                <tr key={m.id}>
                  <td>
                    <span className={`status-dot ${r.ok ? "is-online" : "is-offline"}`} aria-hidden="true" />
                    <span className="data-strong">{m.name}</span>
                    <span className="sr-only">{r.ok ? " (online)" : " (offline)"}</span>
                    {!r.ok && <div className="data-note">{r.message}</div>}
                  </td>
                  <td className="data-mono">{m.address}:{m.port}</td>
                  <td>{r.ok ? r.data.host.hostname : m.hostname ?? "—"}</td>
                  <td>{r.ok ? r.data.agent.version : m.agentVersion ?? "—"}</td>
                  <td>{ago(seen)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </>
  )
}
