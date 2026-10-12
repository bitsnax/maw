import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { getMachineInfo } from "@/lib/machines"
import ProjectSettings from "./ProjectSettings"

export const dynamic = "force-dynamic"

function when(d: Date) {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      machine: true,
      createdBy: { select: { name: true, email: true } },
      sessions: { orderBy: { createdAt: "desc" }, include: { user: { select: { name: true, email: true } } } },
    },
  })
  if (!project) notFound()
  const info = await getMachineInfo(project.machine)

  return (
    <>
      <div className="page-head">
        <h1 className="app-title">{project.name}</h1>
        <Link href="/projects" className="btn">Back to projects</Link>
      </div>

      <p className="machine-facts">
        <span>
          <span className={`status-dot ${info.ok ? "is-online" : "is-offline"}`} aria-hidden="true" />
          <Link href={`/machines/${project.machine.id}`} className="data-link">{project.machine.name}</Link>
          <span className="sr-only">{info.ok ? " (online)" : " (offline)"}</span>
        </span>
        <span className="data-mono">{project.root}</span>
        <span>Added {when(project.createdAt)}{project.createdBy ? ` by ${project.createdBy.name || project.createdBy.email}` : ""}</span>
      </p>
      {!info.ok && <div className="form-alert spaced">{info.message}</div>}

      <h2 className="section-title">Sessions</h2>
      {project.sessions.length === 0 ? (
        <p className="app-empty">No sessions yet.</p>
      ) : (
        <table className="data-table">
          <thead><tr><th>Title</th><th>Started</th><th>By</th></tr></thead>
          <tbody>
            {project.sessions.map((s) => (
              <tr key={s.id}>
                <td>{s.title}</td>
                <td className="data-nowrap">{when(s.createdAt)}</td>
                <td>{s.user?.name || s.user?.email || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="section-title">Project settings</h2>
      <ProjectSettings projectId={project.id} name={project.name} machineName={project.machine.name} root={project.root} />
    </>
  )
}
