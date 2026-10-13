/**
 * Self-test for stories (lib/stories): Story ─ Phase ─ Step with checklists
 * and findings at story and phase level, numbering, checks, edit, the view
 * MAW builds (getStory), progress, the markdown download, the project
 * profile, and removal with everything under it.
 *
 *   docker compose run --rm --no-deps migrate \
 *     npx tsx scripts/stories-selftest.ts check <machine id> <root>
 *
 * Uses a temporary project (selftest-story-*), removed at the end. Nothing
 * is written into the folder: stories live only in MAW's database.
 */

import { prisma } from "../lib/prisma"
import { createProject, removeProject } from "../lib/projects"
import {
  checkStoryInput, createStory, getStory, listStories, progress, removeStory, saveProfile, storyKey, storyMarkdown, updateStory,
} from "../lib/stories"

let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  const d = detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}`
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : d}`)
  if (!ok) failed++
}

async function run(machineId: string, root: string) {
  console.log("checks")
  const e = checkStoryInput({ title: " ", request: "", branch: "bad branch.." })
  check("empty title and request, bad branch refused", !!e.title && !!e.request && !!e.branch, e)
  check("a normal branch is fine", !checkStoryInput({ title: "x", request: "y", branch: "story/tool-count" }).branch)
  check("story key", storyKey({ number: 3, title: "Tool count per Connection!" }) === "3-tool-count-per-connection")

  const tag = `selftest-story-${Date.now() % 100000}`
  const p = await createProject({ name: tag, machineId, root }, null)
  if (!p.ok) { check("project for the test", false, p); return }
  try {
    console.log("stories")
    const a = await createStory(p.project.id, null, { title: "Tool count per connection", request: "Show how many tools use each connection.", branch: "" })
    const b = await createStory(p.project.id, null, { title: "Second", request: "Another." })
    check("created and numbered 1, 2; status Planning phases; no branch", a.ok && b.ok && a.story.number === 1 && b.story.number === 2 && a.story.status === "planning" && a.story.branch === null)
    if (!a.ok || !b.ok) return
    const u = await updateStory(a.story.id, { title: "Tool count", request: "Show the count.", branch: "story-1-tool-count" })
    const a2 = await prisma.story.findUniqueOrThrow({ where: { id: a.story.id } })
    check("edited: title, request, branch", u.ok && a2.title === "Tool count" && a2.branch === "story-1-tool-count")
    check("listed newest first", (await listStories(p.project.id)).map((s) => s.number).join() === "2,1")

    console.log("phases, steps, checklists (as the agent's tools will write them)")
    const s = a.story.id
    const q1 = await prisma.storyItem.create({ data: { storyId: s, position: 1, text: "Where is the connections page?", checked: true } })
    await prisma.storyItem.create({ data: { storyId: s, position: 2, text: "Count drafts too?", developer: true } })
    await prisma.storyFinding.create({ data: { storyId: s, itemId: q1.id, position: 1, heading: "Connections page", body: "`web/src/app/settings/connections/page.tsx`" } })
    const ph1 = await prisma.storyPhase.create({ data: { storyId: s, number: 1, title: "Count", goal: "A count function.", status: "in-progress" } })
    const ph2 = await prisma.storyPhase.create({ data: { storyId: s, number: 2, title: "Show it", status: "pending" } })
    const pq = await prisma.storyItem.create({ data: { storyId: s, phaseId: ph1.id, position: 1, text: "How are bindings shaped?", checked: true } })
    await prisma.storyFinding.create({ data: { storyId: s, phaseId: ph1.id, itemId: pq.id, position: 1, heading: "Bindings", body: "kind http | sql" } })
    await prisma.storyStep.create({ data: { phaseId: ph1.id, number: 1, title: "Count function", status: "done", result: "added" } })
    await prisma.storyStep.create({ data: { phaseId: ph1.id, number: 2, title: "Tests", check: true } })
    await prisma.storyStep.create({ data: { phaseId: ph2.id, number: 1, title: "Show it" } })
    const g = (await getStory(s))!
    check("story checklist: 2 items, one finding under the first", g.items.length === 2 && g.items[0]!.findings.length === 1 && g.items[1]!.developer)
    check("phase items stay out of the story checklist", g.items.every((i) => i.phaseId === null))
    check("phases in order, with their steps", g.phases.map((x) => `${x.number}:${x.steps.length}`).join() === "1:2,2:1")
    check("phase checklist with its finding", g.phases[0]!.items.length === 1 && g.phases[0]!.items[0]!.findings[0]!.body === "kind http | sql")
    const pr = progress(g)
    check("progress: 2 phases, 1 of 3 steps done", pr.phases === 2 && pr.steps === 3 && pr.done === 1, pr)
    const md = storyMarkdown(g)
    check("markdown: story, checklist, phases, steps", md.startsWith("# Story 1: Tool count") && md.includes("- [x] Where is the connections page?")
      && md.includes("- [ ] (for you) Count drafts too?") && md.includes("## Phase 2: Show it") && md.includes("### Step 1.2: Tests"), md.slice(0, 300))

    console.log("profile")
    await saveProfile(p.project.id, { profile: "Source roots: web/src", verifyCommands: ["npx tsc --noEmit", " "], protectedBranches: ["main", "", "master"] })
    const row = await prisma.project.findUniqueOrThrow({ where: { id: p.project.id } })
    check("saved (blank entries dropped)", row.verifyCommands.join() === "npx tsc --noEmit" && row.protectedBranches.join() === "main,master" && row.profile === "Source roots: web/src")

    console.log("removal")
    await removeStory(s)
    const left = await Promise.all([prisma.storyPhase.count({ where: { storyId: s } }), prisma.storyItem.count({ where: { storyId: s } }), prisma.storyFinding.count({ where: { storyId: s } }), prisma.storyStep.count({ where: { phaseId: { in: [ph1.id, ph2.id] } } })])
    check("a removed story takes its phases, steps, items and findings", left.join() === "0,0,0,0", left)
  } finally {
    const r = await removeProject(p.project.id, null)
    check("project removed (its stories with it)", r.ok && (await prisma.story.count({ where: { projectId: p.project.id } })) === 0)
  }
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === "check" && a && b) await run(a, b)
  else throw new Error("usage: stories-selftest.ts check <machine id> <root>")
  console.log(failed === 0 ? "PASS" : `FAIL (${failed})`)
  await prisma.$disconnect()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
