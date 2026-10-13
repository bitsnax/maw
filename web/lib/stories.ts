import { prisma } from "./prisma"

// Stories: the database record of work too big for one model session.
//   Story ─ Phase ─ Step
// You write a story (title + request) on the project page; MAW's agent
// breaks it into phases (story planning) and each phase into steps (phase
// planning), then works the steps; every planning pass and every step is its
// own session that fits in 65,536 tokens. Nothing is written into the
// project for any of this. Not a "use server" file, so self-tests can call
// it; the actions that call it check for an admin first.

export const STORY_STATUS: Record<string, string> = {
  planning: "Planning phases", "phases-ready": "Phases ready for you", "in-progress": "In progress",
  paused: "Paused", blocked: "Blocked", done: "Done",
}
export const PHASE_STATUS: Record<string, string> = {
  pending: "Not planned yet", planning: "Planning steps", "steps-ready": "Steps ready for you",
  "in-progress": "In progress", blocked: "Blocked", done: "Done",
}
export const STEP_STATUS: Record<string, string> = {
  pending: "Pending", "in-progress": "In progress", done: "Done", blocked: "Blocked",
}

export type NewStoryInput = { title: string; request: string; branch?: string }

/** kebab-case of a title, for {story} and branch names: "3-tool-count". */
export function storyKey(s: { number: number; title: string }): string {
  const k = s.title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "")
  return k ? `${s.number}-${k}` : String(s.number)
}

const BRANCH = /^(?!\/|.*\/\/|.*\.\.|.*@\{|.*[\s~^:?*[\\]).{1,100}(?<![/.]|\.lock)$/

export function checkStoryInput(i: NewStoryInput): Record<string, string> {
  const e: Record<string, string> = {}
  const t = i.title.trim()
  if (!t) e.title = "Give the story a short title, for example Tool count per connection."
  else if (t.length > 120) e.title = "At most 120 characters."
  if (!i.request.trim()) e.request = "Describe the work: what to build or change, what is out of scope, and when it is done."
  const b = (i.branch ?? "").trim()
  if (b && !BRANCH.test(b)) e.branch = "Not a valid git branch name."
  return e
}

export async function createStory(projectId: string, userId: string | null, i: NewStoryInput) {
  const errors = checkStoryInput(i)
  if (Object.keys(errors).length) return { ok: false as const, errors }
  const story = await prisma.$transaction(async (tx) => {
    const last = await tx.story.findFirst({ where: { projectId }, orderBy: { number: "desc" }, select: { number: true } })
    return tx.story.create({
      data: { projectId, number: (last?.number ?? 0) + 1, title: i.title.trim(), request: i.request.trim(), branch: i.branch?.trim() || null, createdById: userId },
    })
  })
  return { ok: true as const, story }
}

export async function updateStory(id: string, i: NewStoryInput) {
  const errors = checkStoryInput(i)
  if (Object.keys(errors).length) return { ok: false as const, errors }
  const r = await prisma.story.updateMany({ where: { id }, data: { title: i.title.trim(), request: i.request.trim(), branch: i.branch?.trim() || null } })
  return r.count ? { ok: true as const } : { ok: false as const, errors: {}, message: "This story no longer exists." }
}

export function listStories(projectId: string) {
  return prisma.story.findMany({
    where: { projectId }, orderBy: { number: "desc" },
    include: { phases: { select: { status: true, steps: { select: { status: true } } } } },
  })
}

export function getStory(id: string) {
  return prisma.story.findUnique({
    where: { id },
    include: {
      project: { include: { machine: { select: { name: true } } } },
      items: { where: { phaseId: null }, orderBy: { position: "asc" }, include: { findings: { orderBy: { position: "asc" } } } },
      findings: { where: { phaseId: null, itemId: null }, orderBy: { position: "asc" } },
      phases: {
        orderBy: { number: "asc" },
        include: {
          steps: { orderBy: { number: "asc" } },
          items: { orderBy: { position: "asc" }, include: { findings: { orderBy: { position: "asc" } } } },
          findings: { where: { itemId: null }, orderBy: { position: "asc" } },
        },
      },
    },
  })
}
export type FullStory = NonNullable<Awaited<ReturnType<typeof getStory>>>

export async function removeStory(id: string) {
  await prisma.commandRun.deleteMany({ where: { storyId: id } })
  return (await prisma.story.deleteMany({ where: { id } })).count > 0
}

/** Steps done / all steps across the story's phases. */
export function progress(s: { phases: { steps: { status: string }[] }[] }) {
  const steps = s.phases.flatMap((p) => p.steps)
  return { phases: s.phases.length, steps: steps.length, done: steps.filter((x) => x.status === "done").length }
}

export async function saveProfile(projectId: string, i: { profile: string; verifyCommands: string[]; protectedBranches: string[] }) {
  await prisma.project.update({
    where: { id: projectId },
    data: {
      profile: i.profile.trim(),
      verifyCommands: i.verifyCommands.map((c) => c.trim()).filter(Boolean),
      protectedBranches: i.protectedBranches.map((c) => c.trim()).filter(Boolean),
    },
  })
}

// ---- markdown download (for your own records; never written to the project) ----

const sec = (h: string, body: string) => (body.trim() ? `${h}\n${body.trim()}\n` : "")

function checklist(items: FullStory["items"]): string {
  return items.map((q) => {
    const lines = [`- [${q.checked ? "x" : " "}] ${q.developer ? "(for you) " : ""}${q.text}${q.answer ? `\n  Answer: ${q.answer}` : ""}`]
    for (const f of q.findings) lines.push(`  #### ${f.heading || "Finding"}\n${f.body.replace(/^/gm, "  ")}`)
    return lines.join("\n")
  }).join("\n")
}

export function storyMarkdown(s: FullStory): string {
  const out: string[] = [
    `# Story ${s.number}: ${s.title}`,
    `Project ${s.project.name} — ${s.project.root} on ${s.project.machine.name} · ${STORY_STATUS[s.status] ?? s.status}${s.branch ? ` · branch ${s.branch}` : ""}`,
    `Downloaded ${new Date().toISOString()}`, "",
    sec("## Request", s.request), sec("## Overview", s.overview), sec("## Out of scope", s.outOfScope), sec("## Notes", s.notes),
  ]
  if (s.items.length) out.push("## Story checklist", checklist(s.items), "")
  for (const f of s.findings) out.push(`### ${f.heading || "Finding"}`, f.body, "")
  for (const p of s.phases) {
    out.push(`## Phase ${p.number}: ${p.title} (${PHASE_STATUS[p.status] ?? p.status})`, sec("### Goal", p.goal), sec("### Approach", p.approach), sec("### Notes", p.notes))
    if (p.items.length) out.push("### Phase checklist", checklist(p.items as FullStory["items"]), "")
    for (const f of p.findings) out.push(`#### ${f.heading || "Finding"}`, f.body, "")
    for (const x of p.steps) {
      out.push(`### Step ${p.number}.${x.number}: ${x.title} (${STEP_STATUS[x.status] ?? x.status})`, x.files ? `Files: ${x.files}` : "",
        sec("#### Goal", x.goal), sec("#### Read budget", x.readBudget), sec("#### Context", x.context), sec("#### Changes", x.changes),
        sec("#### Verification", x.verification), sec("#### Manual check", x.manualCheck), sec("#### Result", x.result), sec("#### Verify output", x.verifyOutput))
    }
  }
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim() + "\n"
}
