import { prisma } from "./prisma"
import { getMachineCommand, startMachineCommand, type MachineRecord } from "./machines"

// What MAW itself runs on the project's machine around a step session:
// the branch check before a step, the project's verify commands after it,
// and the record of what the step changed (git status and git diff). These
// run as the machine's user in the project folder, like the command buttons,
// and show in the machine's Recent actions.

export type RunOut = { ok: boolean; exitCode: number | null; state: string; text: string; ms: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Runs one command in `root` and waits for it to end; `tick` is called while waiting. */
export async function runOnMachine(m: MachineRecord, root: string, command: string, timeoutSeconds: number, tick?: () => void, tail = 300): Promise<RunOut> {
  const t0 = Date.now()
  const st = await startMachineCommand(m, null, root, command, timeoutSeconds)
  if (!st.ok) return { ok: false, exitCode: null, state: "failed", text: `MAW could not start it: ${st.message}`, ms: 0 }
  for (;;) {
    await sleep(1500)
    tick?.()
    const r = await getMachineCommand(m, st.data.jobId, tail)
    if (!r.ok) {
      if (Date.now() - t0 > (timeoutSeconds + 60) * 1000) return { ok: false, exitCode: null, state: "lost", text: `MAW lost the command: ${r.message}`, ms: Date.now() - t0 }
      continue
    }
    if (r.data.state === "running") continue
    const text = r.data.lines.filter((l) => !l.login).map((l) => l.text).join("\n")
    const ok = r.data.state === "exited" && r.data.exitCode === 0
    return { ok, exitCode: r.data.exitCode, state: r.data.state, text, ms: r.data.durationMs }
  }
}

type ProjectRow = { root: string; verifyCommands: string[]; protectedBranches: string[]; machine: MachineRecord }

function projectOf(projectId: string): Promise<ProjectRow> {
  return prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { machine: true } })
}

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`)

/** Runs the project's verify commands in order, stopping at the first that fails. */
export async function runVerify(projectId: string, tick?: () => void): Promise<{ ok: boolean; output: string; failed: string | null }> {
  const p = await projectOf(projectId)
  const parts: string[] = []
  for (const c of p.verifyCommands) {
    const r = await runOnMachine(p.machine, p.root, c, 1800, tick, 150)
    parts.push(`$ ${c}\n${r.text.trim()}\n→ ${r.state === "exited" ? `exit ${r.exitCode}` : r.state} in ${secs(r.ms)}`)
    if (!r.ok) return { ok: false, output: parts.join("\n\n").slice(-20_000), failed: c }
  }
  return { ok: true, output: p.verifyCommands.length ? parts.join("\n\n").slice(-20_000) : "(the project has no verify commands)", failed: null }
}

/** git status and diff of the project now (what is not committed), capped. */
export async function projectChanges(projectId: string, tick?: () => void): Promise<string> {
  const p = await projectOf(projectId)
  const r = await runOnMachine(p.machine, p.root, "git status --short && echo && git --no-pager diff --stat && echo && git --no-pager diff", 120, tick, 3000)
  // trimEnd only: git status lines start with a space (" M file").
  const t = r.text.replace(/^\n+/, "").trimEnd()
  return (r.ok ? t || "(no uncommitted changes)" : `git could not show the changes: ${t}`).slice(0, 100_000)
}

/** Why a step must not start on the project's current branch, or null. */
export async function branchProblem(projectId: string, storyBranch: string | null): Promise<string | null> {
  const p = await projectOf(projectId)
  const r = await runOnMachine(p.machine, p.root, "git rev-parse --abbrev-ref HEAD", 30)
  if (!r.ok) return null // not a git project: nothing to check
  const cur = r.text.trim().split("\n").at(-1)?.trim() ?? ""
  if (p.protectedBranches.includes(cur)) {
    return `The project is on ${cur}, a protected branch, so MAW does not change files there.${storyBranch ? ` Create or switch to ${storyBranch} with your command button;` : " Switch to a story branch with your command button;"} the next step starts within a minute after that.`
  }
  if (storyBranch && cur !== storyBranch) {
    return `The project is on ${cur}, but this story's branch is ${storyBranch}. Switch to ${storyBranch} with your command button (or change the story's branch); the next step starts within a minute after that.`
  }
  return null
}
