"use server"

import { revalidatePath } from "next/cache"
import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import {
  PHASE_STATUS, STEP_STATUS, STORY_STATUS, createStory, getStory, removeStory, saveProfile, storyKey, updateStory,
  type NewStoryInput,
} from "@/lib/stories"

// Stories (admin only, like Projects). Every action checks the admin itself;
// none throws to the browser.

type Reply<T> = { ok: true; data: T } | { ok: false; message: string; errors?: Record<string, string> }

type Finding = { id: string; heading: string; body: string }
type Item = { id: string; text: string; checked: boolean; developer: boolean; answer: string | null; findings: Finding[] }
export type StoryView = {
  id: string; projectId: string; number: number; key: string; title: string; request: string
  status: string; statusLabel: string; branch: string | null; updatedAt: string
  overview: string; outOfScope: string; notes: string
  items: Item[]; findings: Finding[]
  phases: {
    id: string; number: number; title: string; goal: string; approach: string; notes: string; status: string; statusLabel: string
    items: Item[]; findings: Finding[]
    steps: {
      id: string; number: number; title: string; files: string; check: boolean; status: string; statusLabel: string
      goal: string; readBudget: string; context: string; changes: string; verification: string
      manualCheck: string; result: string; verifyOutput: string
    }[]
  }[]
}

const f = (x: { id: string; heading: string; body: string }): Finding => ({ id: x.id, heading: x.heading, body: x.body })
const item = (q: { id: string; text: string; checked: boolean; developer: boolean; answer: string | null; findings: Finding[] }): Item =>
  ({ id: q.id, text: q.text, checked: q.checked, developer: q.developer, answer: q.answer, findings: q.findings.map(f) })

export async function storyView(id: string): Promise<Reply<StoryView>> {
  if (!(await adminSession())) return { ok: false, message: "Stories are for admins." }
  const s = await getStory(id)
  if (!s) return { ok: false, message: "This story no longer exists." }
  return {
    ok: true,
    data: {
      id: s.id, projectId: s.projectId, number: s.number, key: storyKey(s), title: s.title, request: s.request,
      status: s.status, statusLabel: STORY_STATUS[s.status] ?? s.status, branch: s.branch, updatedAt: s.updatedAt.toISOString(),
      overview: s.overview, outOfScope: s.outOfScope, notes: s.notes,
      items: s.items.map(item), findings: s.findings.map(f),
      phases: s.phases.map((p) => ({
        id: p.id, number: p.number, title: p.title, goal: p.goal, approach: p.approach, notes: p.notes,
        status: p.status, statusLabel: PHASE_STATUS[p.status] ?? p.status,
        items: p.items.map(item), findings: p.findings.map(f),
        steps: p.steps.map((x) => ({
          id: x.id, number: x.number, title: x.title, files: x.files, check: x.check, status: x.status, statusLabel: STEP_STATUS[x.status] ?? x.status,
          goal: x.goal, readBudget: x.readBudget, context: x.context, changes: x.changes, verification: x.verification,
          manualCheck: x.manualCheck, result: x.result, verifyOutput: x.verifyOutput,
        })),
      })),
    },
  }
}

export async function newStory(projectId: string, input: NewStoryInput): Promise<Reply<{ id: string }>> {
  const a = await adminSession()
  if (!a) return { ok: false, message: "Only an admin can write stories." }
  if (!(await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }))) return { ok: false, message: "This project no longer exists." }
  const r = await createStory(projectId, a.user.id, input)
  if (!r.ok) return { ok: false, message: "Check the fields below.", errors: r.errors }
  revalidatePath(`/projects/${projectId}`)
  return { ok: true, data: { id: r.story.id } }
}

export async function editStory(id: string, input: NewStoryInput): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can change stories." }
  const s = await prisma.story.findUnique({ where: { id }, select: { projectId: true } })
  const r = await updateStory(id, input)
  if (!r.ok) return { ok: false, message: r.message ?? "Check the fields below.", errors: r.errors }
  if (s) revalidatePath(`/projects/${s.projectId}`)
  return { ok: true, data: null }
}

export async function deleteStory(id: string): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can remove stories." }
  const s = await prisma.story.findUnique({ where: { id }, select: { projectId: true } })
  await removeStory(id)
  if (s) revalidatePath(`/projects/${s.projectId}`)
  return { ok: true, data: null }
}

/** Your answer to a checklist item marked for you; answering checks it. */
export async function answerStoryItem(itemId: string, answer: string): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can answer." }
  const a = answer.trim()
  if (!a) return { ok: false, message: "Write the answer first." }
  const q = await prisma.storyItem.update({ where: { id: itemId }, data: { answer: a, checked: true, checkedAt: new Date() } }).catch(() => null)
  return q ? { ok: true, data: null } : { ok: false, message: "This item no longer exists." }
}

export async function saveProjectProfile(projectId: string, input: { profile: string; verifyCommands: string; protectedBranches: string }): Promise<Reply<null>> {
  if (!(await adminSession())) return { ok: false, message: "Only an admin can change the profile." }
  await saveProfile(projectId, {
    profile: input.profile,
    verifyCommands: input.verifyCommands.split("\n"),
    protectedBranches: input.protectedBranches.split(/[,\s]+/),
  })
  revalidatePath(`/projects/${projectId}`)
  return { ok: true, data: null }
}
