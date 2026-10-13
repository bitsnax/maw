"use client"

import { useCallback, useEffect, useState } from "react"
import { answerStoryItem, storyView, type StoryView as SV } from "./story-actions"
import { Markdown } from "./conversation"

// A story in the Dashboard's output window:
//   Story ─ Phase ─ Step
// the request, the story plan (overview, checklist with findings), then each
// phase (goal, approach, its own checklist, its steps; a step opens to its
// full text). MAW's agent fills this in session by session; stories are
// written and edited on the project page.

type Item = SV["items"][number]

export default function StoryView({ storyId }: { storyId: string }) {
  const [s, setS] = useState<SV | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await storyView(storyId)
    if (r.ok) { setS(r.data); setError(null) } else setError(r.message)
  }, [storyId])
  useEffect(() => {
    let cancelled = false
    storyView(storyId).then((r) => { if (cancelled) return; if (r.ok) { setS(r.data); setError(null) } else setError(r.message) })
    return () => { cancelled = true }
  }, [storyId])

  if (error) return <div className="form-alert">{error}</div>
  if (!s || s.id !== storyId) return <p className="app-empty">Loading the story…</p>

  const allSteps = s.phases.flatMap((p) => p.steps)
  const done = allSteps.filter((x) => x.status === "done").length
  const planned = s.phases.length > 0 || s.items.length > 0 || !!s.overview.trim()
  const answer = async (id: string, a: string) => { const r = await answerStoryItem(id, a); if (!r.ok) setError(r.message); else await load() }

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

      <section className="story-sec">
        <h3 className="story-h">Request</h3>
        <Markdown text={s.request} />
      </section>

      {!planned && (
        <p className="app-empty story-wait">
          Not planned yet. MAW&apos;s agent breaks the story into phases (story planning), then each phase into steps (phase planning),
          then works the steps, each in its own session. That starts once the runner is in place (Phase 4, step 05).
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
          <Fold key={p.id} className={`story-sec story-phase is-${p.status}`} defaultOpen={(p.status !== "done" && p.status !== "pending") || p.items.some((q) => q.developer && !q.checked)}>
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
                      <span className="story-step-status">{x.statusLabel}</span>
                    </summary>
                    <div className="story-step-body">
                      {x.files && <div className="story-meta">Files: <span className="data-mono">{x.files}</span></div>}
                      {([["Goal", x.goal], ["Read budget", x.readBudget], ["Context", x.context], ["Changes", x.changes], ["Verification", x.verification],
                        ["Manual check", x.manualCheck], ["Result", x.result], ["Verify output", x.verifyOutput]] as const)
                        .filter(([, t]) => t.trim()).map(([h, t]) => (
                          <div key={h} className="story-sub"><div className="story-sub-h">{h}</div><Markdown text={t} /></div>
                        ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </Fold>
        )
      })}
    </div>
  )
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
