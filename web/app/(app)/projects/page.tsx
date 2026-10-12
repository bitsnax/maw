import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { getMachineInfo } from "@/lib/machines"
import { listProjects } from "@/lib/projects"
import { liveStates } from "@/lib/session-status"

export const dynamic = "force-dynamic"

// Projects: a folder on a paired machine that OpenCode sessions work in.
// Each project's machine is asked for /v1/info (3-second timeout, once per
// machine), so the dot reflects the machine right now.

function when(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export default async function ProjectsPage() {
  const projects = await listProjects()
  const machines = [...new Map(projects.map((p) => [p.machine.id, p.machine])).values()]
  const [online, live] = await Promise.all([
    Promise.all(machines.map(async (m) => [m.id, (await getMachineInfo(m)).ok] as const)).then((e) => new Map(e)),
    liveStates(),
  ])
  const sessionsOf = await prisma.projectSession.findMany({ select: { id: true, projectId: true } })
  const active = new Map<string, number>()
  for (const s of sessionsOf) if (live.states.has(s.id)) active.set(s.projectId, (active.get(s.projectId) ?? 0) + 1)

  return (
    <>
      <div className="page-head">
        <h1 className="app-title">Projects</h1>
        <Link href="/projects/new" className="btn btn-primary">Add project</Link>
      </div>

      {projects.length === 0 ? (
        <p className="app-empty">No projects yet. A project is a folder on one of your machines, such as /opt/caw.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>Name</th><th>Machine</th><th>Folder</th><th>Sessions</th><th>Added</th></tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const up = online.get(p.machine.id) === true
              return (
                <tr key={p.id}>
                  <td><Link href={`/projects/${p.id}`} className="data-strong data-link">{p.name}</Link></td>
                  <td>
                    <span className={`status-dot ${up ? "is-online" : "is-offline"}`} aria-hidden="true" />
                    <Link href={`/machines/${p.machine.id}`} className="data-link">{p.machine.name}</Link>
                    <span className="sr-only">{up ? " (online)" : " (offline)"}</span>
                  </td>
                  <td className="data-mono">{p.root}</td>
                  <td>{p._count.sessions}{active.get(p.id) ? <span className="session-state"> · {active.get(p.id)} active</span> : null}</td>
                  <td className="data-nowrap">{when(p.createdAt)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </>
  )
}
