import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import SessionView from "./SessionView"

export const dynamic = "force-dynamic"

export default async function SessionPage({ params }: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await params
  const s = await prisma.projectSession.findUnique({
    where: { id: sid },
    include: { project: { include: { machine: { select: { name: true } } } } },
  })
  if (!s || s.projectId !== id) notFound()

  return (
    <>
      <div className="page-head">
        <h1 className="app-title">{s.title}</h1>
        <Link href={`/projects/${s.project.id}`} className="btn">Back to {s.project.name}</Link>
      </div>
      <SessionView sessionId={s.id} title={s.title} root={s.project.root} machineName={s.project.machine.name} />
    </>
  )
}
