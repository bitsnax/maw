import Link from "next/link"
import { prisma } from "@/lib/prisma"
import AddProjectForm from "./AddProjectForm"

export const dynamic = "force-dynamic"

export default async function NewProjectPage() {
  const machines = await prisma.machine.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, address: true } })
  return (
    <>
      <div className="page-head">
        <h1 className="app-title">Add project</h1>
        <Link href="/projects" className="btn">Back to projects</Link>
      </div>
      {machines.length === 0 ? (
        <p className="app-empty">
          Pair a machine first (<Link href="/machines/new" className="data-link">Add machine</Link>); a project is a folder on one.
        </p>
      ) : (
        <AddProjectForm machines={machines} />
      )}
    </>
  )
}
