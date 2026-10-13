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
    if (q.answer) out.push(`   Developer's answer (follow it exactly; it overrides anything above that disagrees): ${q.answer}`)
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
    "- Set \"forDeveloper\": true only for a choice that only the developer can make (it is not in the code). Those wait for the developer's answer. Write such an item as the question followed by its options (A) … (B) … so a short answer is unambiguous.",
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

// ---- phase planning ---------------------------------------------------------------

type Phase = FullStory["phases"][number]

/** Story checklist answers given to phase sessions (about 4,000 tokens). */
export const STORY_FINDINGS_FOR_PHASE = 16_000
/** This phase's own checklist and findings in the steps prompt. */
export const PHASE_FINDINGS_BUDGET = 40_000

function phaseContext(s: FullStory, ph: Phase): string[] {
  return [
    "## Story plan (approved by the developer)",
    s.overview.trim() || "(no overview)",
    ...(s.outOfScope.trim() ? ["", "Out of scope:", s.outOfScope.trim()] : []),
    ...(s.notes.trim() ? ["", "Notes (decisions for every later session):", s.notes.trim()] : []),
    "",
    "## Phases",
    ...s.phases.map((p) => `${p.number}. ${p.title}${p.id === ph.id ? "   ← this session's phase" : ` (${p.status})`}`),
    "",
    `## Phase ${ph.number}: ${ph.title}`,
    `Goal: ${ph.goal.trim()}`,
    ...(ph.approach.trim() ? [`Approach: ${ph.approach.trim()}`] : []),
    ...(ph.notes.trim() ? [`Notes: ${ph.notes.trim()}`] : []),
    "",
    "## The story checklist with its answers",
    checklistText(s.items, STORY_FINDINGS_FOR_PHASE),
    "",
  ]
}

export function phaseChecklistPrompt(s: FullStory, ph: Phase): string {
  return [
    ...common(s, `phase-checklist, story ${s.number}, phase ${ph.number}`, true),
    ...phaseContext(s, ph),
    `## Your task: phase ${ph.number}'s checklist`,
    "Before this phase is split into steps, list what is still unknown: only questions that the story checklist answers above do NOT already settle and that the steps need (for example the exact current code at each place this phase changes, a helper's signature, a test to extend).",
    "- Add each with item_add {\"text\": \"…\"}. Each must be answerable by reading the project in one short session.",
    "- Set \"forDeveloper\": true only for a choice only the developer can make; write the question followed by its options (A) … (B) ….",
    "- If the answers above already cover everything the steps need, add nothing and reply \"nothing to add\". That is a normal outcome; do not invent questions.",
    ...(ph.items.length ? ["", "## Already on this phase's checklist", checklistText(ph.items, 4000)] : []),
  ].join("\n")
}

export function phaseItemPrompt(s: FullStory, ph: Phase, item: Phase["items"][number]): string {
  const notes = item.findings.map((f) => `- ${f.heading || "Finding"}: ${f.body}`).join("\n")
  return [
    ...common(s, `phase-item, story ${s.number}, phase ${ph.number}, item ${item.position}`, true),
    ...phaseContext(s, ph),
    `## Your task: phase ${ph.number} checklist item ${item.position}`,
    item.text,
    "",
    "Answer it from the project:",
    "- Record what you find with finding_add {\"heading\": \"…\", \"body\": \"…\"}: exact names, file paths with line numbers, code shapes copied from the source, so the steps can be written without reading the files again.",
    "- Then item_check {\"answered\": true, \"note\": \"the answer in a few lines\"}; or, if you cannot finish, item_check {\"answered\": false, \"note\": \"what is known and what is left\"}.",
    "- A new question the steps need goes in with item_add (\"forDeveloper\": true, with options, if only the developer can decide).",
    ...(notes ? ["", "## What earlier sessions recorded on this item", notes] : []),
    "",
    `## The rest of phase ${ph.number}'s checklist`,
    checklistText(ph.items, FINDINGS_BUDGET, item.id),
  ].join("\n")
}

export function phaseStepsPrompt(s: FullStory, ph: Phase): string {
  return [
    ...common(s, `phase-steps, story ${s.number}, phase ${ph.number}`, true),
    ...phaseContext(s, ph),
    `## Phase ${ph.number}'s checklist with its answers`,
    checklistText(ph.items, PHASE_FINDINGS_BUDGET),
    ...(ph.findings.length ? ["", "## Other findings for this phase", ...ph.findings.map((f) => `- ${f.heading || "Finding"}: ${f.body}`)] : []),
    "",
    `## Your task: phase ${ph.number}'s steps`,
    "Work from what is above; read the project only to fill a real gap. Add each step with step_add, in the order they are carried out.",
    "Each step is carried out later by a fresh session with a 65,536-token context that sees only the story plan and that step's text, so every step must stand on its own:",
    "- title: short, imperative.",
    "- files: the files it changes, comma separated.",
    "- goal: what is true when the step is done.",
    "- readBudget: exactly what to read first (file and line range or a grep), kept small.",
    "- context: the facts the step needs, copied from the findings (names, signatures, line anchors, decisions), so it does not search for them.",
    "- changes: the exact edits, numbered.",
    "- verification: anything to check beyond the project's verify commands (MAW runs those after every step).",
    "- manualCheck and needsCheck: true only when the developer must check something by hand (in the browser, say); describe exactly what to do and what to expect.",
    "Size: a step changes 1 to 3 files and fits in one session; a schema change ships with its migration in the same step. Usually 1 to 6 steps.",
    "You may refine the phase with phase_plan_set {\"approach\": \"…\", \"notes\": \"…\"} first. Follow every developer's answer exactly.",
  ].join("\n")
}

// ---- carrying out a step ------------------------------------------------------------

type Step = Phase["steps"][number]

/** The prompt of a step session: the story plan, the phase, your answers on
 *  it, then the step's full text (with what earlier sessions recorded). */
export function stepPrompt(s: FullStory, ph: Phase, st: Step, stepText: string): string {
  const answers = ph.items.filter((q) => q.answer).map((q) => `- ${q.text}: ${q.answer}`)
  return [
    ...common(s, `step, story ${s.number}, step ${ph.number}.${st.number}`, false),
    "## Story plan (approved by the developer)",
    s.overview.trim() || "(no overview)",
    ...(s.outOfScope.trim() ? ["", "Out of scope:", s.outOfScope.trim()] : []),
    ...(s.notes.trim() ? ["", "Notes (decisions for every session):", s.notes.trim()] : []),
    "",
    `## Phase ${ph.number}: ${ph.title}`,
    `Goal: ${ph.goal.trim()}`,
    ...(ph.approach.trim() ? [`Approach: ${ph.approach.trim()}`] : []),
    ...(ph.notes.trim() ? [`Notes: ${ph.notes.trim()}`] : []),
    ...(answers.length ? ["", "The developer's answers for this phase (follow them exactly):", ...answers] : []),
    "",
    stepText,
    ...(st.verifyOutput.trim() ? ["", "## The verify commands' output after the last try (fix what failed)", "```", st.verifyOutput.trim().slice(-6000), "```"] : []),
    "",
    `## Your task: carry out step ${ph.number}.${st.number}`,
    "- Read what the read budget names, then make the changes with edit and write. Change only what the step says; if something outside it must change too, make the smallest change and say so in a step_note.",
    "- After each change, record it with step_note {\"text\": \"file: what changed\"}, so a later session can continue if this one runs out of room.",
    "- If \"Result so far\" above has notes, an earlier session already did part of this step: check those changes are in place and continue from there. Lines starting \"Developer:\" are the developer's instructions; follow them exactly.",
    "- Do not commit or switch branches (refused); leave the changes in the working tree for the developer.",
    "- You may run quick checks. MAW runs the project's verify commands after you finish.",
    "- When the changes are made: step_finish {\"status\": \"done\", \"summary\": \"what changed, file by file\"}. If the step cannot be done as written: step_finish {\"status\": \"blocked\", \"summary\": \"why, and what would unblock it\"}. Then stop.",
  ].join("\n")
}
