import { prisma } from "./prisma"
import { workspacePath } from "./workspace"
import { ocMessages, ocQuestions, ocStatus, type OcPart } from "./opencode"

// What each session is doing right now, for the Dashboard and the session
// lists. OpenCode keeps status per workspace, so this asks each project's
// workspace once (status and open questions), then the last message of each
// working session for what it is doing. Sessions that are idle are left out.
//
//   working   the model is answering (since: the last prompt sent from MAW)
//   waiting   the model asked a question and waits for an answer
//   retry     the model's server failed; OpenCode retries (message says why)

export type LiveState = {
  state: "working" | "waiting" | "retry"
  since: string | null
  activity: string
  message?: string
}

const TOOL: Record<string, string> = {
  read: "Read", write: "Write", edit: "Edit", glob: "Find files", grep: "Search", bash: "Command",
  task: "Sub-task", webfetch: "Web page", todowrite: "To-do list", skill: "Skill", question: "Question", compress: "Compress context",
}

function describe(p: OcPart | undefined): string {
  if (!p) return "Starting"
  if (p.type === "tool") {
    const i = p.state?.input ?? {}
    const what = ["command", "filePath", "pattern"].map((k) => i[k]).find((v) => typeof v === "string") as string | undefined
    const label = TOOL[p.tool ?? ""] ?? p.tool ?? "Tool"
    return what ? `${label}: ${what.length > 80 ? what.slice(0, 80) + "…" : what}` : label
  }
  if (p.type === "reasoning") return "Thinking"
  if (p.type === "text") return "Writing the answer"
  return "Working"
}

/** Live states of the sessions in these projects (default: all), by session id.
 *  `unreachable` is set when maw-opencode did not answer. */
export async function liveStates(projectIds?: string[]): Promise<{ states: Map<string, LiveState>; unreachable: string | null }> {
  const projects = await prisma.project.findMany({
    where: { ...(projectIds ? { id: { in: projectIds } } : {}), sessions: { some: {} } },
    select: { slug: true, sessions: { select: { id: true, updatedAt: true } } },
  })
  const states = new Map<string, LiveState>()
  let unreachable: string | null = null
  await Promise.all(projects.map(async (p) => {
    const dir = workspacePath(p.slug)
    const [st, qs] = await Promise.all([ocStatus(dir, 8000), ocQuestions(dir, 8000)])
    if (!st.ok) { unreachable = st.message; return }
    const mine = new Map(p.sessions.map((s) => [s.id, s]))
    const asking = new Set(qs.ok ? qs.data.map((q) => q.sessionID) : [])
    await Promise.all([...mine.values()].map(async (s) => {
      const t = st.data[s.id]?.type
      const since = s.updatedAt.toISOString()
      if (asking.has(s.id)) { states.set(s.id, { state: "waiting", since, activity: "Asked you a question" }); return }
      if (t === "retry") { states.set(s.id, { state: "retry", since, activity: "Retrying", message: st.data[s.id]?.message }); return }
      if (t !== "busy") return
      const m = await ocMessages(dir, s.id, 1)
      const last = m.ok ? m.data.at(-1) : undefined
      const part = last?.info.role === "assistant" ? last.parts.filter((x) => ["tool", "reasoning", "text"].includes(x.type)).at(-1) : undefined
      states.set(s.id, { state: "working", since, activity: describe(part) })
    }))
  }))
  return { states, unreachable }
}
