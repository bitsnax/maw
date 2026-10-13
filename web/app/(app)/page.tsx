import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import Workspace from "./workspace/Workspace"
import { workspaceSnapshot } from "./workspace/actions"

// Dashboard: the workspace where the work happens — pick a project and a
// session, run the project's command buttons, prompt the model, watch the
// output. Setup lives in Projects and Machines.

export const dynamic = "force-dynamic"

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ project?: string; session?: string; task?: string }> }) {
  const admin = await adminSession()
  if (!admin) {
    return (
      <>
        <h1 className="app-title">Dashboard</h1>
        <p className="app-empty">The workspace is for admins.</p>
      </>
    )
  }
  const q = await searchParams
  // A session or task in the address picks its project.
  const owner = q.session ? await prisma.projectSession.findUnique({ where: { id: q.session }, select: { projectId: true } }) : null
  const taskOwner = !owner && q.task ? await prisma.task.findUnique({ where: { id: q.task }, select: { projectId: true } }) : null
  const snap = await workspaceSnapshot(owner?.projectId ?? taskOwner?.projectId ?? q.project ?? null)
  if (!snap.ok) return <p className="app-empty">{snap.message}</p>
  return <Workspace initial={snap.data} initialSession={owner ? q.session! : null} initialTask={taskOwner ? q.task! : null} />
}
