import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { getMachineInfo } from "@/lib/machines"
import { liveStates } from "@/lib/session-status"
import ProjectSettings from "./ProjectSettings"
import ProjectCommands from "../ProjectCommands"
import { listCommands } from "@/lib/project-commands"
import { TASK_STATUS, listTasks, progress } from "@/lib/tasks"
import ProjectTasks from "./ProjectTasks"
import ProjectProfile from "./ProjectProfile"

export const dynamic = "force-dynamic"

function when(d: Date) {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
}

function SessionState({ state }: { state?: "working" | "waiting" | "retry" }) {
  const label = state === "working" ? "Working" : state === "waiting" ? "Waiting for you" : state === "retry" ? "Retrying" : "Idle"
  return <span className={`session-state is-${state ?? "idle"}`}>{label}</span>
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      machine: true,
      createdBy: { select: { name: true, email: true } },
      sessions: { orderBy: { updatedAt: "desc" }, include: { user: { select: { name: true, email: true } } } },
    },
  })
  if (!project) notFound()
  // Sessions MAW ran for a task are listed with their task (Dashboard sidebar), not here.
  const jobIds = new Set((await prisma.taskJob.findMany({ where: { sessionId: { in: project.sessions.map((x) => x.id) } }, select: { sessionId: true } })).map((j) => j.sessionId))
  project.sessions = project.sessions.filter((x) => !jobIds.has(x.id))
  const [info, live, commands, tasks] = await Promise.all([
    getMachineInfo(project.machine), liveStates([project.id]), listCommands(project.id), listTasks(project.id),
  ])

  return (
    <>
      <div className="page-head">
        <h1 className="app-title">{project.name}</h1>
        <span className="settings-actions">
          <Link href={`/?project=${project.id}`} className="btn btn-primary">Open on Dashboard</Link>
          <Link href="/projects" className="btn">Back to projects</Link>
        </span>
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
      {live.unreachable && <div className="form-alert spaced">maw-opencode did not answer: {live.unreachable}</div>}

      <h2 className="section-title">Command buttons</h2>
      <ProjectCommands projectId={project.id} root={project.root} machineName={project.machine.name}
        commands={commands.map((c) => ({ id: c.id, title: c.title, command: c.command }))} />

      <h2 className="section-title">Tasks</h2>
      <ProjectTasks projectId={project.id}
        tasks={tasks.map((t) => {
          const pr = progress(t)
          return {
            id: t.id, number: t.number, title: t.title, request: t.request, branch: t.branch,
            status: t.status, statusLabel: TASK_STATUS[t.status] ?? t.status,
            phases: pr.phases, steps: pr.steps ? `${pr.done} of ${pr.steps}` : "—", updated: when(t.updatedAt),
          }
        })} />

      <h2 className="section-title">Sessions</h2>
      {project.sessions.length === 0 ? (
        <p className="app-empty">No sessions yet. Start one on the <Link href={`/?project=${project.id}`} className="data-link">Dashboard</Link>.</p>
      ) : (
        <table className="data-table">
          <thead><tr><th>Title</th><th>Status</th><th>Started</th><th>Last prompt</th><th>By</th></tr></thead>
          <tbody>
            {project.sessions.map((s) => (
              <tr key={s.id}>
                <td><Link href={`/?project=${project.id}&session=${s.id}`} className="data-link">{s.title}</Link></td>
                <td><SessionState state={live.states.get(s.id)?.state} /></td>
                <td className="data-nowrap">{when(s.createdAt)}</td>
                <td className="data-nowrap">{s.updatedAt.getTime() - s.createdAt.getTime() > 1000 ? when(s.updatedAt) : "—"}</td>
                <td>{s.user?.name || s.user?.email || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="section-title">Project profile</h2>
      <ProjectProfile projectId={project.id} profile={project.profile} verifyCommands={project.verifyCommands} protectedBranches={project.protectedBranches} deployCommand={project.deployCommand} />

      <h2 className="section-title">Project settings</h2>
      <ProjectSettings projectId={project.id} name={project.name} machineName={project.machine.name} root={project.root} />
    </>
  )
}
