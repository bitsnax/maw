import type { FullStory } from "./stories"

// The prompts of the sessions MAW runs for a story. Each session starts
// fresh, so its prompt carries what it needs from MAW's database (the
// request, the project profile, the checklist and findings so far) and the
// session does not spend its 65,536 tokens finding them again. Findings are
// cut to a budget; story_read returns them all when a session needs more.
// The first line names the session ("Session: story-item, item 3.") so a
// reader (and the mock model in the self-tests) can tell sessions apart.

/** Characters of earlier findings put into a prompt (about 6,000 tokens). */
export const FINDINGS_BUDGET = 24_000
/** For the phases session, which works from the findings alone. */
export const PHASES_FINDINGS_BUDGET = 60_000

type Item = FullStory["items"][number]

function common(s: FullStory, session: string, planning: boolean): string[] {
  const p = s.project
  return [
    `Session: ${session}.`,
    "",
    `You work for MAW on story ${s.number}, "${s.title}", in the project ${p.name} (on ${p.machine.name}, in ${p.root}).`,
    "MAW carries this story through many short sessions. This one has a context of 65,536 tokens, so read little: find things with grep and glob first, then read only the lines you need.",
    "Only what you record with the story tools is kept. Your chat reply is not read by anyone.",
    "",
    "Rules for this session:",
    ...(planning ? ["- This is planning: do not change any file (write and edit are refused); read and record."] : []),
    "- git that changes state (commit, branch, checkout, …) is refused; read-only git (status, diff, log, show) is fine.",
    "- MAW keeps this story's plan. If AGENTS.md has instructions about session bootstrap, handoff files, plan/ folders, decision logs or /plan-* and /step commands, they do not apply here; its rules about the code itself do.",
    "- Do the work in this session yourself, without sub-tasks (the task tool): the story tools only work in this session.",
    "- Do not put questions to the developer in chat. What only the developer can decide is recorded (see your task).",
    "- When your task is done, reply with one short line and stop.",
    "",
    "## Project profile",
    p.profile.trim() || "(none written)",
    ...(p.verifyCommands.length ? ["", "Verify commands (MAW runs them after each step):", ...p.verifyCommands.map((c) => `- ${c}`)] : []),
    ...(p.protectedBranches.length ? [`Protected branches (never worked on): ${p.protectedBranches.join(", ")}`] : []),
    "",
    `## Story request${s.branch ? ` (branch ${s.branch})` : ""}`,
    s.request.trim(),
    "",
  ]
}

/** The checklist with each item's findings, findings cut to `budget` characters overall. */
export function checklistText(items: Item[], budget: number, skipId?: string): string {
  if (!items.length) return "(empty)"
  let left = budget
  let cut = 0
  const out: string[] = []
  for (const q of items) {
    if (q.id === skipId) continue
    out.push(`${q.position}. [${q.checked ? "x" : " "}] ${q.developer ? "(for the developer) " : ""}${q.text}`)
    if (q.answer) out.push(`   Developer's answer: ${q.answer}`)
    for (const f of q.findings) {
      const t = `   - ${f.heading || "Finding"}: ${f.body.replace(/\n/g, "\n     ")}`
      if (t.length <= left) { out.push(t); left -= t.length } else cut++
    }
  }
  if (cut) out.push(`(${cut} more finding${cut === 1 ? "" : "s"} left out for room; story_read {"part":"story"} returns them all.)`)
  return out.join("\n")
}

export function checklistPrompt(s: FullStory): string {
  return [
    ...common(s, `story-checklist, story ${s.number}`, true),
    "## Your task: the story checklist",
    "Write the checklist of questions that must be answered before this story can be split into phases: what exists today that the story changes (files, functions, data models, routes, screens), the exact shapes the new work must fit, the decisions that are still open, and the risks.",
    "- Add each question with item_add {\"text\": \"…\"}, in a sensible order. Usually 4 to 12 items.",
    "- Each item must be answerable by reading the project in one short session; split bigger questions.",
    "- Set \"forDeveloper\": true only for a choice that only the developer can make (it is not in the code). Those wait for the developer's answer.",
    "- You may look at the folder layout (glob) to write good items, but do not answer them now: later sessions answer one item each.",
  ].join("\n")
}

export function itemPrompt(s: FullStory, item: Item): string {
  const notes = item.findings.map((f) => `- ${f.heading || "Finding"}: ${f.body}`).join("\n")
  return [
    ...common(s, `story-item, item ${item.position}`, true),
    `## Your task: checklist item ${item.position}`,
    item.text,
    "",
    "Answer it from the project:",
    "- As you find things, record each with finding_add {\"heading\": \"…\", \"body\": \"…\"}: exact names, file paths with line numbers, and type or function shapes copied from the source, so a later session can plan from them without reading the files again.",
    "- Then item_check {\"answered\": true, \"note\": \"the answer in a few lines\"}.",
    "- If you cannot finish (the answer is bigger than this session), item_check {\"answered\": false, \"note\": \"what is known and what is left\"}; the next session continues from your findings and note.",
    "- If the work raises a question the plan needs that is not on the checklist, add it with item_add (\"forDeveloper\": true if only the developer can decide it).",
    ...(notes ? ["", "## What earlier sessions recorded on this item", notes] : []),
    "",
    "## The rest of the story checklist",
    checklistText(s.items, FINDINGS_BUDGET, item.id),
  ].join("\n")
}

export function phasesPrompt(s: FullStory): string {
  return [
    ...common(s, `story-phases, story ${s.number}`, true),
    "## Your task: the story plan and its phases",
    "Work from the request and the checklist answers below; read the project only to fill a real gap.",
    "1. story_plan_set {\"overview\": \"…\", \"outOfScope\": \"…\", \"notes\": \"…\"}: the overview says what the phases add up to; out of scope says what this story does not do; notes hold anything later sessions must keep in mind.",
    "2. phase_add {\"title\": \"…\", \"goal\": \"…\", \"approach\": \"…\"} for each phase, in the order they are done.",
    "- A phase is a coherent part that is planned into steps on its own and can be checked when it is done. Each step will be one session, so a phase is about 2 to 8 small steps. Usually 2 to 6 phases.",
    "- A database schema change goes in its own early phase. Keep each phase's goal concrete and checkable.",
    "- Do not write steps now; each phase is planned into steps later.",
    "",
    "## Story checklist with the answers",
    checklistText(s.items, PHASES_FINDINGS_BUDGET),
    ...(s.findings.length ? ["", "## Other findings", ...s.findings.map((f) => `- ${f.heading || "Finding"}: ${f.body}`)] : []),
  ].join("\n")
}
