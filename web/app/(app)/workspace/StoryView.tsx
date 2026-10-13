"use client"

import { useCallback, useEffect, useState } from "react"
import { answerStoryItem, phaseControl, saveStoryBranch, stepControl, storyControl, storyView, type StoryView as SV } from "./story-actions"
import { Markdown } from "./conversation"

// A story in the Dashboard's output window:
//   Story ─ Phase ─ Step
// the request, the story plan (overview, checklist with findings), then each
// phase (goal, approach, its own checklist, its steps; a step opens to its
// full text). MAW's agent fills this in session by session; stories are
// written and edited on the project page. The bar under the head says what
// MAW's runner is doing for the story now, and holds what is yours to do
// (pause, retry, approve the phases); "Sessions" lists every session MAW ran
// for it, each openable.

type Item = SV["items"][number]
const EVERY = 4000
const JOB_STATE: Record<string, string> = { running: "Running", done: "Done", failed: "Failed", stopped: "Stopped" }
const clock = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
const took = (a: string, b: string | null, now: number) => {
  const sec = Math.max(0, Math.round(((b ? new Date(b).getTime() : now) - new Date(a).getTime()) / 1000))
  return sec < 60 ? `${sec} s` : sec < 3600 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`
}

export default function StoryView({ storyId, onOpenSession }: { storyId: string; onOpenSession: (id: string) => void }) {
  const [s, setS] = useState<SV | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The direction box under the bar: what it is for, and its text.
  const [dir, setDir] = useState<{ for: "replan-phases" | "plan-steps" | "replan-steps" | "not-right" | "retry" | "reopen"; text: string; stepId?: string } | null>(null)
  // The branch box under "no branch": the suggested name until you type.
  const [branch, setBranch] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    const r = await storyView(storyId)
    if (r.ok) { setS(r.data); setError(null) } else setError(r.message)
  }, [storyId])
  // Loaded at once, then every few seconds while the tab is visible.
  useEffect(() => {
    let stopped = false
    let t: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (!document.hidden) {
        try {
          const r = await storyView(storyId)
          if (stopped) return
          if (r.ok) { setS(r.data); setError(null) } else setError(r.message)
          setNow(Date.now())
        } catch { /* next tick */ }
      }
      if (!stopped) t = setTimeout(tick, EVERY)
    }
    void tick()
    return () => { stopped = true; if (t) clearTimeout(t) }
  }, [storyId])

  if (error) return <div className="form-alert">{error}</div>
  if (!s || s.id !== storyId) return <p className="app-empty">Loading the story…</p>

  const allSteps = s.phases.flatMap((p) => p.steps)
  const done = allSteps.filter((x) => x.status === "done").length
  const planned = s.phases.length > 0 || s.items.length > 0 || !!s.overview.trim()
  const answer = async (id: string, a: string) => { const r = await answerStoryItem(id, a); if (!r.ok) setError(r.message); else await load() }
  const act = async (a: "pause" | "resume" | "approve-phases" | "replan-phases", direction?: string) => {
    setBusy(true)
    const r = await storyControl(s.id, a, direction)
    setBusy(false)
    if (!r.ok) setError(r.message)
    else { setDir(null); await load() }
  }
  const cur = s.phases.find((p) => p.status !== "done") ?? null
  const phaseAct = async (a: "plan-steps" | "approve-steps" | "replan-steps", direction?: string) => {
    if (!cur) return
    setBusy(true)
    const r = await phaseControl(cur.id, a, direction)
    setBusy(false)
    if (!r.ok) setError(r.message)
    else { setDir(null); await load() }
  }
  // The step being worked on: the current phase's first step that is not done.
  const step = cur && cur.status === "in-progress" ? cur.steps.find((x) => x.status !== "done") ?? null : null
  const stepAct = async (a: "checked" | "not-right" | "retry" | "mark-done" | "reopen", text?: string, stepId?: string) => {
    const id = stepId ?? step?.id
    if (!id) return
    setBusy(true)
    const r = await stepControl(id, a, text)
    setBusy(false)
    if (!r.ok) setError(r.message)
    else { setDir(null); await load() }
  }
  const stepJob = step ? s.jobs.find((j) => j.label === `Step ${cur!.number}.${step.number}` && j.session) : undefined
  const forYou = s.items.filter((q) => q.developer && !q.checked).length
  const curForYou = cur ? cur.items.filter((q) => q.developer && !q.checked).length : 0
  const failed = s.status === "blocked" ? s.jobs.find((j) => j.state === "failed" || j.state === "stopped") : undefined
  const runnerDown = s.runnerAge === null || s.runnerAge > 60
  const items = (n: number) => `${n} checklist item${n === 1 ? "" : "s"}`

  // What MAW's runner is doing for the story right now (planning, or planning the current phase).
  const working = (waitingFor: number, where: string) => (<>
    {s.now ? (
      <span className="story-run-text"><span className="chat-working">Working</span> {s.now.job.label} · {s.now.activity} · {took(s.now.job.createdAt, null, now)}</span>
    ) : waitingFor ? (
      <span className="story-run-text">Waiting for you: {items(waitingFor)} {where} marked <strong>For you</strong>. Planning goes on once {waitingFor === 1 ? "it is" : "they are"} answered.</span>
    ) : runnerDown ? (
      <span className="story-run-text">MAW&apos;s runner is not running (the maw-runner service), so nothing is being planned.</span>
    ) : (
      <span className="story-run-text">Starting the next session…</span>
    )}
    <span className="story-run-actions">
      {s.now?.job.session && <button type="button" className="btn btn-small" onClick={() => onOpenSession(s.now!.job.sessionId)}>Open session</button>}
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => void act("pause")}>Pause</button>
    </span>
  </>)
  const DIR_LABEL = {
    "replan-phases": ["What should change? (optional; the next plan of the phases reads it)", "Plan again"],
    "plan-steps": [`Direction for phase ${cur?.number ?? ""}'s steps (optional; every planning session for this phase reads it and follows it)`, "Plan steps"],
    "replan-steps": [`What should change in phase ${cur?.number ?? ""}'s steps? (optional; the next plan of the steps reads it)`, "Plan again"],
    "not-right": [`What is not right in step ${cur?.number ?? ""}.${step?.number ?? ""}? (the step runs again, and its next session reads this)`, "Run the step again"],
    "retry": [`Direction for step ${cur?.number ?? ""}.${step?.number ?? ""} (optional; its next session reads it and follows it)`, "Try again"],
    "reopen": ["What is wrong with this step? (it runs again, and its next session reads this)", "Reopen the step"],
  } as const
  const dirBox = dir && (
    <div className="story-replan">
      <label className="form-label" htmlFor="st-dir">{DIR_LABEL[dir.for][0]}</label>
      <textarea id="st-dir" className="form-input" rows={4} value={dir.text} onChange={(e) => setDir({ ...dir, text: e.target.value })} />
      <span className="story-run-actions">
        <button type="button" className="btn btn-small" onClick={() => setDir(null)}>Cancel</button>
        <button type="button" className="btn btn-small btn-primary"
          disabled={busy || ((dir.for === "not-right" || dir.for === "reopen") && !dir.text.trim())}
          onClick={() => void (dir.for === "replan-phases" ? act("replan-phases", dir.text)
            : dir.for === "not-right" || dir.for === "retry" || dir.for === "reopen" ? stepAct(dir.for, dir.text, dir.stepId) : phaseAct(dir.for, dir.text))}>{DIR_LABEL[dir.for][1]}</button>
      </span>
    </div>
  )

  // Where the story is, always shown first in the bar.
  const where = s.status === "planning" ? "Story planning"
    : s.status === "phases-ready" ? "Story plan: phases to approve"
    : s.status === "done" ? "Every phase done"
    : cur ? `Phase ${cur.number} of ${s.phases.length}: ${cur.title}${step ? ` · Step ${cur.number}.${step.number} of ${cur.steps.length}: ${step.title}` : ""}`
    : ""
  // Whether the next move is yours (the bar says what it is).
  const needed = !s.now && (["paused", "blocked", "phases-ready"].includes(s.status) || forYou > 0 || (s.status === "in-progress" && (
    !s.branch || !!s.runnerNote || curForYou > 0 || cur?.status === "pending" || cur?.status === "steps-ready" || step?.status === "waiting-check" || step?.status === "blocked")))

  const bar = (() => {
    if (dir) return dirBox
    switch (s.status) {
      case "planning": return working(forYou, "in the story checklist")
      case "paused": return (<>
        <span className="story-run-text">Paused. Resume goes on from where {s.resumeTo === "in-progress" ? "phase planning" : "planning"} stopped.</span>
        <span className="story-run-actions"><button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void act("resume")}>Resume</button></span>
      </>)
      case "blocked":
        if (step?.status === "blocked") return (<>
          <span className="story-run-text"><strong>Blocked at step {cur!.number}.{step.number}</strong>: {lastLine(step.result) || "see the step below."} Run it again (with a direction, if it helps), or mark it done if you did it yourself.</span>
          <span className="story-run-actions">
            {stepJob && <button type="button" className="btn btn-small" onClick={() => onOpenSession(stepJob.sessionId)}>Open session</button>}
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void stepAct("mark-done")}>Mark done</button>
            <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => setDir({ for: "retry", text: "" })}>Try again…</button>
          </span>
        </>)
        return (<>
        <span className="story-run-text"><strong>Blocked</strong>{failed ? ` at ${failed.label}: ${failed.note}` : "."} Retry runs that part again.</span>
        <span className="story-run-actions">
          {failed?.session && <button type="button" className="btn btn-small" onClick={() => onOpenSession(failed.sessionId)}>Open session</button>}
          <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void act("resume")}>Retry</button>
        </span>
      </>)
      case "phases-ready": return (<>
        <span className="story-run-text">The phases are ready for you. Read them below, then approve them, or have them planned again.</span>
        <span className="story-run-actions">
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => setDir({ for: "replan-phases", text: "" })}>Plan again…</button>
          <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void act("approve-phases")}>Approve phases</button>
        </span>
      </>)
      case "in-progress":
        if (step?.status === "verifying") return <span className="story-run-text"><span className="chat-working">Verifying</span> step {cur!.number}.{step.number}: MAW is running the project&apos;s verify commands.</span>
        if (s.now) return working(0, "")
        if (!cur) return <span className="story-run-text">Every phase is done.</span>
        if (cur.status === "pending") return (<>
          <span className="story-run-text">Phase {cur.number}, &ldquo;{cur.title}&rdquo;, is next: MAW&apos;s agent plans it into steps (what the steps still need to know, then the steps). Give it a direction first if the steps must follow something, or plan it as it is.</span>
          <span className="story-run-actions">
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setDir({ for: "plan-steps", text: "" })}>Add direction…</button>
            <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void phaseAct("plan-steps")}>Plan steps</button>
          </span>
        </>)
        if (cur.status === "planning") return working(curForYou, `in phase ${cur.number}'s checklist`)
        if (cur.status === "steps-ready") return (<>
          <span className="story-run-text">Phase {cur.number}&apos;s steps are ready for you. Read them below, then approve them, or have them planned again (its checklist is kept).</span>
          <span className="story-run-actions">
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setDir({ for: "replan-steps", text: "" })}>Plan again…</button>
            <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void phaseAct("approve-steps")}>Approve steps</button>
          </span>
        </>)
        // The phase is in progress: its steps are carried out one by one.
        if (step?.status === "waiting-check") return (<>
          <div className="story-run-text">
            <strong>Step {cur.number}.{step.number}: check it yourself.</strong> MAW made the change{step.deployOutput ? " and deployed it" : ""}, and it passed the verify commands. Clicking below changes nothing: look first, then say how it went.
            {step.manualCheck.trim() && <div className="story-run-check"><Markdown text={step.manualCheck} /></div>}
          </div>
          <span className="story-run-actions">
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setDir({ for: "not-right", text: "" })}>Doesn&apos;t work…</button>
            <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void stepAct("checked")}>Works as described</button>
          </span>
        </>)
        if (step?.status === "deploying") return <span className="story-run-text"><span className="chat-working">Deploying</span> after step {cur.number}.{step.number}: MAW is running the project&apos;s deploy command.</span>
        if (!s.branch) return (<>
          <span className="story-run-text">{s.runnerNote || "This story has no branch. MAW changes files only on the story's own branch: give it one here, then create it with your command button."}</span>
          <span className="story-run-actions">
            <input className="form-input data-mono story-branch-input" aria-label="Story branch" value={branch ?? `story-${s.key}`} onChange={(e) => setBranch(e.target.value)} />
            <button type="button" className="btn btn-small btn-primary" disabled={busy || !(branch ?? `story-${s.key}`).trim()} onClick={async () => {
              setBusy(true); const r = await saveStoryBranch(s.id, branch ?? `story-${s.key}`); setBusy(false)
              if (!r.ok) setError(r.message); else { setBranch(null); await load() }
            }}>Save branch</button>
          </span>
        </>)
        if (s.runnerNote) return <span className="story-run-text">{s.runnerNote}</span>
        return working(0, "")
      case "done": return <span className="story-run-text">Done: every phase is done. The changes are in the project&apos;s working tree; commit and merge them with your buttons.</span>
      default: return null
    }
  })()

  return (
    <div className="story">
      <div className="story-head">
        <span className={`story-status is-${s.status}`}>{s.statusLabel}</span>
        {s.branch && <span className="story-meta">Branch <span className="data-mono">{s.branch}</span></span>}
        {s.phases.length > 0 && <span className="story-meta">{s.phases.length} phase{s.phases.length === 1 ? "" : "s"} · {done} of {allSteps.length} steps done</span>}
        <span className="story-actions">
          <a className="btn btn-small" href={`/api/stories/${s.id}/markdown`}>Download</a>
        </span>
      </div>

      {bar && (
        <div className={`story-run is-${s.status}${cur && s.status === "in-progress" ? ` is-phase-${cur.status}` : ""}${needed ? " is-needed" : ""}`} role="status">
          {(where || needed) && <div className="story-run-where">{needed && <span className="story-needed">Needed from you</span>}{where}</div>}
          {bar}
        </div>
      )}

      <section className="story-sec">
        <h3 className="story-h">Request</h3>
        <Markdown text={s.request} />
      </section>

      {!planned && (
        <p className="app-empty story-wait">
          Not planned yet. MAW&apos;s agent plans the story in short sessions: first a checklist of what the plan needs to know,
          then one session per checklist item, then the phases. Each phase is planned into steps later, and each step is its own session.
        </p>
      )}

      {planned && (
        <Fold className="story-sec" defaultOpen={s.status === "planning" || s.status === "phases-ready" || s.items.some((q) => q.developer && !q.checked)}>
          <summary className="story-h">Story plan <span className="story-count">{s.items.length ? `${s.items.filter((q) => q.checked).length} of ${s.items.length} checked` : ""}</span></summary>
          {([["Overview", s.overview], ["Out of scope", s.outOfScope], ["Notes", s.notes]] as const).filter(([, t]) => t.trim()).map(([h, t]) => (
            <div key={h} className="story-sub"><div className="story-sub-h">{h}</div><Markdown text={t} /></div>
          ))}
          <Checklist items={s.items} onAnswer={answer} />
          <Findings list={s.findings} label="other finding" />
        </Fold>
      )}

      {s.phases.map((p) => {
        const pd = p.steps.filter((x) => x.status === "done").length
        return (
          <Fold key={p.id} className={`story-sec story-phase is-${p.status}`} defaultOpen={s.status === "phases-ready" || p.id === cur?.id || (p.status !== "done" && p.status !== "pending") || p.items.some((q) => q.developer && !q.checked)}>
            <summary className="story-h">
              Phase {p.number}: {p.title}
              <span className={`story-status is-${p.status}`}>{p.statusLabel}</span>
              {p.steps.length > 0 && <span className="story-count">{pd} of {p.steps.length} steps done</span>}
            </summary>
            {([["Goal", p.goal], ["Approach", p.approach], ["Notes", p.notes]] as const).filter(([, t]) => t.trim()).map(([h, t]) => (
              <div key={h} className="story-sub"><div className="story-sub-h">{h}</div><Markdown text={t} /></div>
            ))}
            {p.items.length > 0 && (
              <div className="story-sub">
                <div className="story-sub-h">Phase checklist · {p.items.filter((q) => q.checked).length} of {p.items.length} checked</div>
                <Checklist items={p.items} onAnswer={answer} />
              </div>
            )}
            <Findings list={p.findings} label="other finding" />
            {p.steps.length > 0 && (
              <div className="story-steps">
                {p.steps.map((x) => (
                  <details key={x.id} className={`story-step is-${x.status}`}>
                    <summary>
                      <span className="story-step-n">{p.number}.{x.number}</span>
                      <span className="story-step-title">{x.title}</span>
                      {x.check && <span className="story-dev">Check</span>}
                      {x.deploy && <span className="story-dev is-deploy">Deploy</span>}
                      <span className="story-step-status">{x.statusLabel}</span>
                    </summary>
                    <div className="story-step-body">
                      {x.files && <div className="story-meta">Files: <span className="data-mono">{x.files}</span></div>}
                      {([["Goal", x.goal], ["Read budget", x.readBudget], ["Context", x.context], ["Changes", x.changes], ["Verification", x.verification],
                        ["Manual check", x.manualCheck], ["Result", x.result]] as const)
                        .filter(([, t]) => t.trim()).map(([h, t]) => (
                          <div key={h} className="story-sub"><div className="story-sub-h">{h}</div><Markdown text={t} /></div>
                        ))}
                      {x.verifyOutput.trim() && (
                        <details className="story-sub story-out"><summary className="story-sub-h">Verify output</summary><pre className="story-pre">{x.verifyOutput}</pre></details>
                      )}
                      {x.deployOutput.trim() && (
                        <details className="story-sub story-out"><summary className="story-sub-h">Deploy output</summary><pre className="story-pre">{x.deployOutput}</pre></details>
                      )}
                      {x.status === "done" && (p.id === cur?.id || (s.status === "done" && p.number === s.phases.length)) && (
                        <div><button type="button" className="btn btn-small" disabled={busy} onClick={() => { setDir({ for: "reopen", text: "", stepId: x.id }); setTimeout(() => document.querySelector(".story-run")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50) }}>Reopen…</button></div>
                      )}
                      {x.diff.trim() && (
                        <details className="story-sub story-out"><summary className="story-sub-h">Changes after this step (git status and diff, not committed)</summary><pre className="story-pre">{x.diff}</pre></details>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </Fold>
        )
      })}

      {s.jobs.length > 0 && (
        <Fold className="story-sec" defaultOpen={false}>
          <summary className="story-h">Sessions <span className="story-count">{s.jobs.length}</span></summary>
          <table className="data-table story-jobs">
            <thead><tr><th>Session</th><th>State</th><th>Started</th><th>Took</th><th>Note</th><th aria-label="Open" /></tr></thead>
            <tbody>
              {s.jobs.map((j) => (
                <tr key={j.id}>
                  <td className="data-nowrap">{j.label}</td>
                  <td><span className={`story-status is-${j.state}`}>{JOB_STATE[j.state] ?? j.state}</span></td>
                  <td className="data-nowrap">{clock(j.createdAt)}</td>
                  <td className="data-nowrap">{took(j.createdAt, j.endedAt, now)}</td>
                  <td>{j.note}</td>
                  <td>{j.session && <button type="button" className="data-link ws-linkbtn" onClick={() => onOpenSession(j.sessionId)}>Open</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Fold>
      )}
    </div>
  )
}

/** The last line of a step's result (why it is blocked), without the "Blocked:" prefix. */
function lastLine(t: string): string {
  return (t.trim().split("\n").at(-1) ?? "").replace(/^Blocked: /, "")
}

/** A <details> that starts open or closed, then stays as you leave it. */
function Fold({ defaultOpen, className, children }: { defaultOpen: boolean; className: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return <details className={className} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>{children}</details>
}

function Checklist({ items, onAnswer }: { items: Item[]; onAnswer: (id: string, a: string) => Promise<void> }) {
  if (!items.length) return null
  return (
    <ol className="story-checklist">
      {items.map((q) => (
        <li key={q.id} className={`story-q${q.checked ? " is-checked" : ""}`}>
          <span className="story-q-mark" aria-label={q.checked ? "checked" : "open"}>{q.checked ? "✓" : "○"}</span>
          <div className="story-q-body">
            <div className="story-q-text">{q.developer && <span className="story-dev">For you</span>}<Markdown text={q.text} /></div>
            {q.answer && <div className="story-answer"><strong>Your answer:</strong> {q.answer}</div>}
            {q.developer && !q.checked && <AnswerBox onAnswer={(a) => onAnswer(q.id, a)} />}
            <Findings list={q.findings} label="finding" />
          </div>
        </li>
      ))}
    </ol>
  )
}

function Findings({ list, label }: { list: { id: string; heading: string; body: string }[]; label: string }) {
  if (!list.length) return null
  return (
    <details className="story-findings">
      <summary>{list.length} {label}{list.length === 1 ? "" : "s"}</summary>
      {list.map((f) => (
        <div key={f.id} className="story-finding">
          {f.heading && <div className="story-finding-h">{f.heading}</div>}
          <Markdown text={f.body} />
        </div>
      ))}
    </details>
  )
}

function AnswerBox({ onAnswer }: { onAnswer: (a: string) => Promise<void> }) {
  const [a, setA] = useState("")
  const [busy, setBusy] = useState(false)
  return (
    <div className="story-answer-box">
      <textarea className="form-input" rows={2} value={a} placeholder="Your answer" onChange={(e) => setA(e.target.value)} />
      <button type="button" className="btn btn-small btn-primary" disabled={busy || !a.trim()}
        onClick={async () => { setBusy(true); await onAnswer(a); setBusy(false) }}>Answer</button>
    </div>
  )
}
