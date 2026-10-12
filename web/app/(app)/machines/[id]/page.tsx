import Link from "next/link"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { getMachineInfo, getMachineContainers, agentUpdate, reconcileCommandRecords } from "@/lib/machines"
import Containers from "./Containers"
import MachineSettings from "./MachineSettings"
import Console from "./Console"

export const dynamic = "force-dynamic"

function gib(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(0)} GB`
}

function short(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

function when(d: Date) {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

export default async function MachinePage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ root?: string | string[] }>
}) {
  const { id } = await params
  const rootParam = (await searchParams).root
  const machine = await prisma.machine.findUnique({
    where: { id },
    include: { projects: { select: { id: true, name: true, root: true }, orderBy: { name: "asc" } } },
  })
  if (!machine) notFound()

  const info = await getMachineInfo(machine)
  const update = info.ok ? agentUpdate(machine, info.data.agent.version) : null
  // Commands that ended while nobody was watching: complete their records
  // before they are listed below.
  if (info.ok && !update) await reconcileCommandRecords(machine).catch(() => 0)
  const commands = info.ok ? info.data.agent.commands : undefined

  const [list, actions] = await Promise.all([
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
      {machine.projects.length > 0 && (
        <p className="machine-projects">
          Project{machine.projects.length === 1 ? "" : "s"}:{" "}
          {machine.projects.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ", "}
              <Link href={`/projects/${p.id}`} className="data-link">{p.name}</Link> (<span className="data-mono">{p.root}</span>)
            </span>
          ))}
        </p>
      )}
      {update && (
        <div className="form-alert form-alert-info spaced">
          <p className="data-strong">Agent {update.current} — update available ({update.expected})</p>
          <p>Files, search and commands need agent {update.expected}. The machine keeps its certificate; run:</p>
          <ol className="install-steps">
            {update.steps.map((s) => (
              <li key={s.command}>
                {s.where}:
                <pre className="code-line">{s.command}</pre>
              </li>
            ))}
          </ol>
        </div>
      )}
      {info.ok && !update && commands && !commands.ok && commands.error !== "not checked yet" && (
        <div className="form-alert spaced">Commands do not work on this machine yet: {commands.error}</div>
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

      <h2 className="section-title">Console</h2>
      {!info.ok ? (
        <p className="app-empty">The Console is available when the machine is online.</p>
      ) : update ? (
        <p className="app-empty">The Console needs agent {update.expected}; see the update notice above.</p>
      ) : (
        <Console
          machineId={machine.id}
          base={info.data.agent.allowedBase ?? "/opt"}
          initialRoot={typeof rootParam === "string" && rootParam.startsWith("/") ? rootParam : info.data.agent.allowedBase ?? "/opt"}
          runAs={machine.runAs}
          commandsOk={commands?.ok !== false || commands?.error === "not checked yet"}
          commandsError={commands?.error}
        />
      )}

      <h2 className="section-title">Recent actions</h2>
      {actions.length === 0 ? (
        <p className="app-empty">No actions yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Result</th></tr>
          </thead>
          <tbody>
            {actions.map((a) => (
              <tr key={a.id}>
                <td className="data-nowrap">{when(a.createdAt)}</td>
                <td>{a.user?.name || a.user?.email || "—"}</td>
                <td className="data-mono">{a.action}</td>
                <td className="data-mono" title={a.target ?? undefined}>{short(a.target ?? "", 120)}</td>
                <td className={a.ok ? "" : "data-bad"}>{(a.ok ? a.message ?? "done" : a.message ?? "failed").replace(/ · job [0-9a-f]{16}$/, "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="section-title">Machine settings</h2>
      <MachineSettings machineId={machine.id} name={machine.name} />
    </>
  )
}
