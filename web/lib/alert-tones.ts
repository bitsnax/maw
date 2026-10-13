// Which tone the Dashboard plays for a change (no database here: the browser
// imports it). The digest comes from lib/alerts.ts.

export type TaskAlert = {
  id: string; project: string; number: number; title: string
  status: string
  /** steps waiting for your check */
  checks: number
  /** checklist items waiting for your answer */
  items: number
  /** phases with steps ready for you, or (task in progress) the current phase waiting for Plan steps */
  approvals: number
  /** the runner's wait note (branch) */
  note: string
}

export type Tone = "finished" | "error" | "question" | "stopped"
const RANK: Tone[] = ["error", "question", "finished", "stopped"]

/** The tone for what changed between two digests (null: nothing worth a sound). */
export function toneFor(before: TaskAlert[], after: TaskAlert[], sessions: { before: Map<string, string>; after: Map<string, string> }): Tone | null {
  const tones = new Set<Tone>()
  const old = new Map(before.map((s) => [s.id, s]))
  for (const s of after) {
    const o = old.get(s.id)
    if (!o) continue // a new task is yours: no sound
    if (s.status !== o.status) {
      if (s.status === "done") tones.add("finished")
      else if (s.status === "blocked") tones.add("error")
      else if (s.status === "phases-ready") tones.add("stopped")
    }
    if (s.checks > o.checks || s.items > o.items) tones.add("question")
    if (s.approvals > o.approvals) tones.add("stopped")
    if (s.note && s.note !== o.note) tones.add("stopped")
  }
  // Your own sessions (not the runner's): a turn ends, asks, or fails.
  for (const [id, st] of sessions.before) {
    const now = sessions.after.get(id)
    if (now === st) continue
    if (now === undefined && st !== "waiting") tones.add("stopped")
    else if (now === "waiting") tones.add("question")
    else if (now === "retry") tones.add("error")
  }
  for (const [id, st] of sessions.after) {
    if (!sessions.before.has(id) && st === "waiting") tones.add("question")
  }
  return RANK.find((t) => tones.has(t)) ?? null
}
