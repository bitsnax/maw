"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { answerTaskItem, phaseControl, saveTaskBranch, stepControl, taskControl, taskView, type TaskView } from "./task-actions"
import { Markdown } from "./conversation"
import { Code } from "@/app/components/code"

// A task in the Dashboard's right-hand sidebar (the left pane shows the
// session MAW is working in). Your request becomes a task; MAW plans it into
// phases and each phase into steps, one model session at a time.
//   title        opens your request
//   status box   where the task is, what MAW is doing now, or what it needs
//                from you (with the buttons for it)
//   Plan         opens the plan: overview, out of scope, notes, checklist
//   Phases       each phase and its steps; each opens in a modal
//   Sessions     every session MAW ran for the task; one opens in the left pane
//   Context      how full the shown session's context is

type Item = TaskView["items"][number]
type Phase = TaskView["phases"][number]
type Step = Phase["steps"][number]
type Dir = { for: "replan-phases" | "plan-steps" | "replan-steps" | "not-right" | "retry" | "reopen"; text: string; stepId?: string }
type Open = { kind: "request" } | { kind: "plan" } | { kind: "phase"; id: string } | { kind: "step"; id: string } | null

const EVERY = 4000
const JOB_STATE: Record<string, string> = { running: "Running", done: "Done", failed: "Failed", stopped: "Stopped" }
const took = (a: string, b: string | null, now: number) => {
  const sec = Math.max(0, Math.round(((b ? new Date(b).getTime() : now) - new Date(a).getTime()) / 1000))
  return sec < 60 ? `${sec} s` : sec < 3600 ? `${Math.floor(sec / 60)} min ${sec % 60} s` : `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`
}

export type ContextUse = { tokens: number; limit: number } | null

export function ContextMeter({ use }: { use: ContextUse }) {
  if (!use) return null
  const pct = Math.min(100, Math.round((use.tokens / use.limit) * 100))
  return (
    <div className="side-sec">
      <div className="side-h">Context</div>
      <div className="side-ctx"><span>{use.tokens.toLocaleString()} tokens</span><span>{pct}% of {use.limit.toLocaleString()}</span></div>
      <div className={`side-meter${pct >= 85 ? " is-high" : ""}`}><span style={{ width: `${pct}%` }} /></div>
    </div>
  )
}

export default function TaskPanel({ taskId, shownSession, onOpenSession, onAuto, context }: {
  taskId: string
  shownSession: string | null
  onOpenSession: (id: string) => void
  /** The session the left pane follows by default: the running one, or the latest. */
  onAuto: (id: string | null) => void
  context: ContextUse
}) {
  const [s, setS] = useState<TaskView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dir, setDir] = useState<Dir | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [open, setOpen] = useState<Open>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    const r = await taskView(taskId)
    if (r.ok) { setS(r.data); setError(null) } else setError(r.message)
  }, [taskId])
  useEffect(() => {
    let stopped = false
    let t: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (!document.hidden) {
        try {
          const r = await taskView(taskId)
          if (stopped) return
          if (r.ok) { setS(r.data); setError(null) } else setError(r.message)
          setNow(Date.now())
        } catch { /* next tick */ }
      }
      if (!stopped) t = setTimeout(tick, EVERY)
    }
    void tick()
    return () => { stopped = true; if (t) clearTimeout(t) }
  }, [taskId])

  const auto = s?.id === taskId ? (s.now?.job.sessionId ?? s.jobs.find((j) => j.session)?.sessionId ?? null) : null
  useEffect(() => { onAuto(auto) }, [auto, onAuto])

  if (error && !s) return <aside className="side"><div className="form-alert">{error}</div></aside>
  if (!s || s.id !== taskId) return <aside className="side"><p className="side-empty">Loading the task…</p></aside>

  const allSteps = s.phases.flatMap((p) => p.steps)
  const done = allSteps.filter((x) => x.status === "done").length
  const cur = s.phases.find((p) => p.status !== "done") ?? null
  const step = cur && cur.status === "in-progress" ? cur.steps.find((x) => x.status !== "done") ?? null : null
  const forYou = s.items.filter((q) => q.developer && !q.checked).length
  const curForYou = cur ? cur.items.filter((q) => q.developer && !q.checked).length : 0
  const failed = s.status === "blocked" ? s.jobs.find((j) => j.state === "failed" || j.state === "stopped") : undefined
  const stepJob = step ? s.jobs.find((j) => j.label === `Step ${cur!.number}.${step.number}` && j.session) : undefined
  const runnerDown = s.runnerAge === null || s.runnerAge > 60
  const items = (n: number) => `${n} checklist item${n === 1 ? "" : "s"}`

  const run = async (f: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true)
    const r = await f()
    setBusy(false)
    if (!r.ok) setError(r.message ?? "That did not work.")
    else { setError(null); setDir(null); await load() }
  }
  const act = (a: "pause" | "resume" | "approve-phases" | "replan-phases", d?: string) => run(() => taskControl(s.id, a, d))
  const phaseAct = (a: "plan-steps" | "approve-steps" | "replan-steps", d?: string) => run(() => phaseControl(cur!.id, a, d))
  const stepAct = (a: "checked" | "not-right" | "retry" | "mark-done" | "reopen", d?: string, id?: string) => run(() => stepControl(id ?? step!.id, a, d))
  const answer = async (id: string, a: string) => { const r = await answerTaskItem(id, a); if (!r.ok) setError(r.message); else await load() }

  // ---- what MAW is doing, or what it needs from you ----
  const where = s.status === "planning" ? "Planning the task"
    : s.status === "phases-ready" ? "Phases to approve"
    : s.status === "done" ? "Done"
    : cur ? `Phase ${cur.number} of ${s.phases.length}${step ? ` · Step ${cur.number}.${step.number} of ${cur.steps.length}` : ""}`
    : ""
  const needed = !s.now && (["paused", "blocked", "phases-ready"].includes(s.status) || forYou > 0 || (s.status === "in-progress" && (
    !s.branch || !!s.runnerNote || curForYou > 0 || cur?.status === "pending" || cur?.status === "steps-ready" || step?.status === "waiting-check" || step?.status === "blocked")))

  const working = (waitingFor: number, answerIn: Open) => {
    if (s.now) return (<>
      <p className="side-act-text"><span className="chat-working">Working</span> {s.now.job.label} · {s.now.activity} · {took(s.now.job.createdAt, null, now)}</p>
      <div className="side-act-buttons">
        {s.now.job.session && s.now.job.sessionId !== shownSession && <Btn busy={busy} onClick={() => onOpenSession(s.now!.job.sessionId)}>Show session</Btn>}
        <Btn busy={busy} onClick={() => void act("pause")}>Pause</Btn>
      </div>
    </>)
    if (waitingFor) return (<>
      <p className="side-act-text">{items(waitingFor)} marked <strong>For you</strong>. Planning goes on once {waitingFor === 1 ? "it is" : "they are"} answered.</p>
      <div className="side-act-buttons"><Btn busy={busy} primary onClick={() => setOpen(answerIn)}>Answer…</Btn><Btn busy={busy} onClick={() => void act("pause")}>Pause</Btn></div>
    </>)
    return (<>
      <p className="side-act-text">{runnerDown ? "MAW's runner is not running (the maw-runner service), so nothing moves." : "Starting the next session…"}</p>
      <div className="side-act-buttons"><Btn busy={busy} onClick={() => void act("pause")}>Pause</Btn></div>
    </>)
  }

  const DIR_LABEL = {
    "replan-phases": ["What should change in the phases? (optional)", "Plan again"],
    "plan-steps": [`Direction for phase ${cur?.number ?? ""}'s steps (optional; every planning session for this phase follows it)`, "Plan steps"],
    "replan-steps": [`What should change in phase ${cur?.number ?? ""}'s steps? (optional)`, "Plan again"],
    "not-right": [`What is not right in step ${cur?.number ?? ""}.${step?.number ?? ""}? (the step runs again with this)`, "Run the step again"],
    "retry": [`Direction for step ${cur?.number ?? ""}.${step?.number ?? ""} (optional; its next session follows it)`, "Try again"],
    "reopen": ["What is wrong with this step? (it runs again with this)", "Reopen the step"],
  } as const
  const dirBox = dir && (<>
    <label className="form-label" htmlFor="side-dir">{DIR_LABEL[dir.for][0]}</label>
    <textarea id="side-dir" className="form-input" rows={4} value={dir.text} autoFocus onChange={(e) => setDir({ ...dir, text: e.target.value })} />
    <div className="side-act-buttons">
      <Btn busy={busy} onClick={() => setDir(null)}>Cancel</Btn>
      <Btn busy={busy} primary disabled={(dir.for === "not-right" || dir.for === "reopen") && !dir.text.trim()}
        onClick={() => void (dir.for === "replan-phases" ? act("replan-phases", dir.text)
          : dir.for === "not-right" || dir.for === "retry" || dir.for === "reopen" ? stepAct(dir.for, dir.text, dir.stepId) : phaseAct(dir.for, dir.text))}>{DIR_LABEL[dir.for][1]}</Btn>
    </div>
  </>)

  const action = (() => {
    if (dir) return dirBox
    switch (s.status) {
      case "planning": return working(forYou, { kind: "plan" })
      case "paused": return (<>
        <p className="side-act-text">Paused. Resume goes on from where {s.resumeTo === "in-progress" ? "the phase" : "planning"} stopped.</p>
        <div className="side-act-buttons"><Btn busy={busy} primary onClick={() => void act("resume")}>Resume</Btn></div>
      </>)
      case "blocked":
        if (step?.status === "blocked") return (<>
          <p className="side-act-text"><strong>Step {cur!.number}.{step.number} is blocked:</strong> {lastLine(step.result) || "see the step."}</p>
          <div className="side-act-buttons">
            <Btn busy={busy} onClick={() => setOpen({ kind: "step", id: step.id })}>Open step</Btn>
            {stepJob && <Btn busy={busy} onClick={() => onOpenSession(stepJob.sessionId)}>Show session</Btn>}
            <Btn busy={busy} onClick={() => void stepAct("mark-done")}>Mark done</Btn>
            <Btn busy={busy} primary onClick={() => setDir({ for: "retry", text: "" })}>Try again…</Btn>
          </div>
        </>)
        return (<>
          <p className="side-act-text"><strong>Blocked</strong>{failed ? ` at ${failed.label}: ${failed.note}` : "."}</p>
          <div className="side-act-buttons">
            {failed?.session && <Btn busy={busy} onClick={() => onOpenSession(failed.sessionId)}>Show session</Btn>}
            <Btn busy={busy} primary onClick={() => void act("resume")}>Retry</Btn>
          </div>
        </>)
      case "phases-ready": return (<>
        <p className="side-act-text">The phases are ready. Read them (each opens below), then approve them or have them planned again.</p>
        <div className="side-act-buttons"><Btn busy={busy} onClick={() => setDir({ for: "replan-phases", text: "" })}>Plan again…</Btn><Btn busy={busy} primary onClick={() => void act("approve-phases")}>Approve phases</Btn></div>
      </>)
      case "in-progress":
        if (step?.status === "verifying") return <p className="side-act-text"><span className="chat-working">Verifying</span> step {cur!.number}.{step.number}: running the verify commands.</p>
        if (step?.status === "deploying") return <p className="side-act-text"><span className="chat-working">Deploying</span> after step {cur!.number}.{step.number}: running the deploy command.</p>
        if (s.now) return working(0, null)
        if (!cur) return <p className="side-act-text">Every phase is done.</p>
        if (cur.status === "pending") return (<>
          <p className="side-act-text">Phase {cur.number}, &ldquo;{cur.title}&rdquo;, is next. MAW plans it into steps; give it a direction first if the steps must follow something.</p>
          <div className="side-act-buttons"><Btn busy={busy} onClick={() => setDir({ for: "plan-steps", text: "" })}>Add direction…</Btn><Btn busy={busy} primary onClick={() => void phaseAct("plan-steps")}>Plan steps</Btn></div>
        </>)
        if (cur.status === "planning") return working(curForYou, { kind: "phase", id: cur.id })
        if (cur.status === "steps-ready") return (<>
          <p className="side-act-text">Phase {cur.number}&apos;s steps are ready. Read them (each opens below), then approve them or have them planned again.</p>
          <div className="side-act-buttons"><Btn busy={busy} onClick={() => setDir({ for: "replan-steps", text: "" })}>Plan again…</Btn><Btn busy={busy} primary onClick={() => void phaseAct("approve-steps")}>Approve steps</Btn></div>
        </>)
        if (step?.status === "waiting-check") return (<>
          <p className="side-act-text"><strong>Check step {cur.number}.{step.number} yourself.</strong> MAW made the change{step.deployOutput ? " and deployed it" : ""}; it passed the verify commands. The buttons change nothing: look first.</p>
          {step.manualCheck.trim() && <div className="side-act-check"><Markdown text={step.manualCheck} /></div>}
          <div className="side-act-buttons"><Btn busy={busy} onClick={() => setDir({ for: "not-right", text: "" })}>Doesn&apos;t work…</Btn><Btn busy={busy} primary onClick={() => void stepAct("checked")}>Works as described</Btn></div>
        </>)
        if (!s.branch) return (<>
          <p className="side-act-text">This task has no branch. MAW changes files only on the task&apos;s own branch: name it here, then create it with your command button.</p>
          <input className="form-input data-mono" aria-label="Task branch" value={branch ?? `task-${s.key}`} onChange={(e) => setBranch(e.target.value)} />
          <div className="side-act-buttons">
            <Btn busy={busy} primary disabled={!(branch ?? `task-${s.key}`).trim()} onClick={() => void run(async () => { const r = await saveTaskBranch(s.id, branch ?? `task-${s.key}`); if (r.ok) setBranch(null); return r })}>Save branch</Btn>
          </div>
        </>)
        if (s.runnerNote) return <p className="side-act-text">{s.runnerNote}</p>
        return working(0, null)
      case "done": return <p className="side-act-text">Every phase is done. The changes are in the project&apos;s working tree: commit and merge them with your buttons.</p>
      default: return null
    }
  })()

  const opened = open?.kind === "phase" ? s.phases.find((p) => p.id === open.id) : undefined
  const openedStep = open?.kind === "step" ? s.phases.flatMap((p) => p.steps.map((x) => ({ p, x }))).find((v) => v.x.id === open.id) : undefined
  const planCount = s.items.length ? `${s.items.filter((q) => q.checked).length}/${s.items.length}` : ""

  return (
    <aside className="side">
      <button type="button" className="side-title" title="Open the request" onClick={() => setOpen({ kind: "request" })}>{s.title}</button>
      <div className="side-meta">
        <span className={`task-status is-${s.status}`}>{s.statusLabel}</span>
        {s.branch && <span className="data-mono side-branch" title="The task's branch">{s.branch}</span>}
      </div>
      {s.phases.length > 0 && <div className="side-progress">{done} of {allSteps.length} steps done</div>}

      {action && (
        <div className={`side-act${needed ? " is-needed" : ""}${s.status === "blocked" ? " is-blocked" : ""}`} role="status">
          <div className="side-act-where">{needed && <span className="task-needed">Needed from you</span>}{where}</div>
          {action}
        </div>
      )}
      {error && <div className="form-alert side-error">{error}</div>}

      <div className="side-sec">
        <button type="button" className="side-row side-row-strong" onClick={() => setOpen({ kind: "plan" })}>
          <span>Plan</span><span className="side-count">{planCount}</span>
        </button>
      </div>

      {s.phases.length > 0 && (
        <div className="side-sec">
          <div className="side-h">Phases</div>
          {s.phases.map((p) => (
            <div key={p.id} className={`side-phase${p.id === cur?.id ? " is-current" : ""}`}>
              <button type="button" className="side-row" onClick={() => setOpen({ kind: "phase", id: p.id })}>
                <span className="side-n">{p.number}</span><span className="side-label">{p.title}</span><span className={`side-dot is-${p.status}`} title={p.statusLabel} />
              </button>
              {p.steps.map((x) => (
                <button key={x.id} type="button" className={`side-row side-step${x.id === step?.id ? " is-current" : ""}`} onClick={() => setOpen({ kind: "step", id: x.id })}>
                  <span className="side-n">{p.number}.{x.number}</span><span className="side-label">{x.title}</span>
                  {x.check && <span className="side-tag" title="Needs your check">check</span>}
                  <span className={`side-dot is-${x.status}`} title={x.statusLabel} />
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {s.jobs.length > 0 && (
        <div className="side-sec">
          <div className="side-h">Sessions <span className="side-count">{s.jobs.length}</span></div>
          <div className="side-jobs">
            {s.jobs.map((j) => (
              <button key={j.id} type="button" disabled={!j.session} title={j.note || undefined}
                className={`side-row side-job${j.sessionId === shownSession ? " is-shown" : ""}`} onClick={() => onOpenSession(j.sessionId)}>
                <span className={`side-dot is-${j.state}`} title={JOB_STATE[j.state] ?? j.state} />
                <span className="side-label">{j.label}</span>
                <span className="side-time">{took(j.createdAt, j.endedAt, now)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <ContextMeter use={context} />
      <div className="side-foot"><a className="side-link" href={`/api/tasks/${s.id}/markdown`}>Download as markdown</a></div>

      <Modal open={open?.kind === "request"} title={s.title} onClose={() => setOpen(null)}>
        <div className="modal-sub">Your request</div>
        <Markdown text={s.request} />
      </Modal>

      <Modal open={open?.kind === "plan"} title="Plan" onClose={() => setOpen(null)}>
        {!s.items.length && !s.overview.trim()
          ? <p className="side-empty">Not planned yet. MAW first writes a checklist of what the plan needs to know, answers it one item per session, then writes the phases.</p>
          : (<>
            <Sections list={[["Overview", s.overview], ["Out of scope", s.outOfScope], ["Notes", s.notes]]} />
            {s.items.length > 0 && <div className="modal-sub">Checklist · {planCount} checked</div>}
            <Checklist items={s.items} onAnswer={answer} />
            <Findings list={s.findings} label="other finding" />
          </>)}
      </Modal>

      <Modal open={!!opened} title={opened ? `Phase ${opened.number}: ${opened.title}` : ""} onClose={() => setOpen(null)}>
        {opened && (<>
          <div className="modal-meta"><span className={`task-status is-${opened.status}`}>{opened.statusLabel}</span>{opened.steps.length > 0 && <span>{opened.steps.filter((x) => x.status === "done").length} of {opened.steps.length} steps done</span>}</div>
          <Sections list={[["Goal", opened.goal], ["Approach", opened.approach], ["Notes", opened.notes]]} />
          {opened.items.length > 0 && <div className="modal-sub">Phase checklist · {opened.items.filter((q) => q.checked).length}/{opened.items.length} checked</div>}
          <Checklist items={opened.items} onAnswer={answer} />
          <Findings list={opened.findings} label="other finding" />
          {opened.steps.length > 0 && <div className="modal-sub">Steps</div>}
          {opened.steps.map((x) => (
            <button key={x.id} type="button" className="side-row side-step" onClick={() => setOpen({ kind: "step", id: x.id })}>
              <span className="side-n">{opened.number}.{x.number}</span><span className="side-label">{x.title}</span><span className={`side-dot is-${x.status}`} title={x.statusLabel} />
            </button>
          ))}
        </>)}
      </Modal>

      <Modal open={!!openedStep} title={openedStep ? `Step ${openedStep.p.number}.${openedStep.x.number}: ${openedStep.x.title}` : ""} onClose={() => setOpen(null)} wide>
        {openedStep && <StepBody p={openedStep.p} x={openedStep.x} canReopen={openedStep.x.status === "done" && (openedStep.p.id === cur?.id || (s.status === "done" && openedStep.p.number === s.phases.length))}
          onReopen={() => { setOpen(null); setDir({ for: "reopen", text: "", stepId: openedStep.x.id }) }} />}
      </Modal>
    </aside>
  )
}

function Btn({ children, primary, onClick, disabled, busy }: { children: ReactNode; primary?: boolean; onClick: () => void; disabled?: boolean; busy: boolean }) {
  return <button type="button" className={`btn btn-small${primary ? " btn-primary" : ""}`} disabled={busy || disabled} onClick={onClick}>{children}</button>
}

function StepBody({ p, x, canReopen, onReopen }: { p: Phase; x: Step; canReopen: boolean; onReopen: () => void }) {
  return (<>
    <div className="modal-meta">
      <span className={`task-status is-${x.status}`}>{x.statusLabel}</span>
      {x.check && <span className="side-tag">needs your check</span>}
      {x.deploy && <span className="side-tag">deploys</span>}
      {x.files && <span className="data-mono">{x.files}</span>}
      {canReopen && <button type="button" className="btn btn-small" onClick={onReopen}>Reopen…</button>}
    </div>
    <Sections list={[["Goal", x.goal], ["Read budget", x.readBudget], ["Context", x.context], ["Changes", x.changes], ["Verification", x.verification], ["Manual check", x.manualCheck], ["Result", x.result]]} />
    {x.verifyOutput.trim() && <><div className="modal-sub">Verify output</div><Code text={x.verifyOutput} lang="bash" title={`step ${p.number}.${x.number}`} /></>}
    {x.deployOutput.trim() && <><div className="modal-sub">Deploy output</div><Code text={x.deployOutput} lang="bash" /></>}
    {x.diff.trim() && <><div className="modal-sub">Changes after this step (git status and diff, not committed)</div><Code text={x.diff} lang="diff" /></>}
  </>)
}

function Sections({ list }: { list: [string, string][] }) {
  return <>{list.filter(([, t]) => t.trim()).map(([h, t]) => <div key={h} className="modal-sec"><div className="modal-sub">{h}</div><Markdown text={t} /></div>)}</>
}

/** A modal on the native <dialog>: Esc, the × and a click outside close it. */
export function Modal({ open, title, onClose, wide, children }: { open: boolean; title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement | null>(null)
  useEffect(() => { const d = ref.current; if (!d) return; if (open && !d.open) d.showModal(); else if (!open && d.open) d.close() }, [open])
  return (
    <dialog ref={ref} className={`modal${wide ? " is-wide" : ""}`} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose() }}>
      {open && (<>
        <div className="modal-head"><h3 className="modal-title">{title}</h3><button type="button" className="modal-x" aria-label="Close" onClick={onClose}>×</button></div>
        <div className="modal-body">{children}</div>
      </>)}
    </dialog>
  )
}

/** The last line of a step's result (why it is blocked), without the "Blocked:" prefix. */
function lastLine(t: string): string {
  return (t.trim().split("\n").at(-1) ?? "").replace(/^Blocked: /, "")
}

function Checklist({ items, onAnswer }: { items: Item[]; onAnswer: (id: string, a: string) => Promise<void> }) {
  if (!items.length) return null
  return (
    <ol className="task-checklist">
      {items.map((q) => (
        <li key={q.id} className={`task-q${q.checked ? " is-checked" : ""}`}>
          <span className="task-q-mark" aria-label={q.checked ? "checked" : "open"}>{q.checked ? "✓" : "○"}</span>
          <div className="task-q-body">
            <div className="task-q-text">{q.developer && <span className="task-dev">For you</span>}<Markdown text={q.text} /></div>
            {q.answer && <div className="task-answer"><strong>Your answer:</strong> {q.answer}</div>}
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
    <details className="task-findings">
      <summary>{list.length} {label}{list.length === 1 ? "" : "s"}</summary>
      {list.map((f) => (
        <div key={f.id} className="task-finding">
          {f.heading && <div className="task-finding-h">{f.heading}</div>}
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
    <div className="task-answer-box">
      <textarea className="form-input" rows={2} value={a} placeholder="Your answer" onChange={(e) => setA(e.target.value)} />
      <button type="button" className="btn btn-small btn-primary" disabled={busy || !a.trim()}
        onClick={async () => { setBusy(true); await onAnswer(a); setBusy(false) }}>Answer</button>
    </div>
  )
}
