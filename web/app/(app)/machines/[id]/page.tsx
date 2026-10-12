import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { getMachineInfo, getMachineContainers } from "@/lib/machines"
import Containers from "./Containers"

export const dynamic = "force-dynamic"

function gib(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(0)} GB`
}

function when(d: Date) {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

export default async function MachinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const machine = await prisma.machine.findUnique({ where: { id } })
  if (!machine) notFound()

  const [info, list, actions] = await Promise.all([
    getMachineInfo(machine),
    getMachineContainers(machine),
    prisma.machineAction.findMany({
      where: { machineId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { user: { select: { name: true, email: true } } },
    }),
  ])

  return (
    <>
      <div className="page-head">
        <h1 className="app-title">
          <span className={`status-dot ${info.ok ? "is-online" : "is-offline"}`} aria-hidden="true" />
          {machine.name}
          <span className="sr-only">{info.ok ? " (online)" : " (offline)"}</span>
        </h1>
        <Link href="/machines" className="btn">Back to machines</Link>
      </div>

      {info.ok ? (
        <p className="machine-facts">
          <span className="data-mono">{machine.address}:{machine.port}</span>
          <span>{info.data.host.hostname}</span>
          <span>{info.data.host.os}</span>
          <span>{info.data.host.cpus} CPUs · {gib(info.data.host.memoryBytes)}</span>
          {info.data.docker && <span>Docker {info.data.docker.version}</span>}
          <span>Agent {info.data.agent.version}</span>
        </p>
      ) : (
        <div className="form-alert">{info.message}</div>
      )}
      {info.ok && !info.data.docker && (
        <div className="form-alert">The agent is running but cannot reach Docker: {info.data.dockerError}</div>
      )}

      <h2 className="section-title">Containers</h2>
      {list.ok ? (
        <Containers machineId={machine.id} containers={list.data.containers} />
      ) : (
        <p className="app-empty">{info.ok ? list.message : "Containers appear when the machine is online."}</p>
      )}

      <h2 className="section-title">Recent actions</h2>
      {actions.length === 0 ? (
        <p className="app-empty">No actions yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>When</th><th>Who</th><th>Action</th><th>Container</th><th>Result</th></tr>
          </thead>
          <tbody>
            {actions.map((a) => (
              <tr key={a.id}>
                <td className="data-nowrap">{when(a.createdAt)}</td>
                <td>{a.user?.name || a.user?.email || "—"}</td>
                <td className="data-mono">{a.action}</td>
                <td className="data-mono">{a.target ?? ""}</td>
                <td className={a.ok ? "" : "data-bad"}>{a.ok ? a.message ?? "done" : a.message ?? "failed"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
