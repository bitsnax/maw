"use client"

import { useState, type ReactNode } from "react"
import type { OcMessage, OcPart, OcQuestion } from "@/lib/opencode"

// The pieces of a conversation shown in the Dashboard's output window:
// messages (prompts, streamed answers, thinking, tool rows), question cards,
// turn footers, and the helpers that apply OpenCode's events to the list.

export type Msg = { info: OcMessage["info"]; parts: OcPart[] }
export type Ev = { type: string; properties?: Record<string, unknown>; message?: string }

const TOOL_LABEL: Record<string, string> = {
  read: "Read", write: "Write", edit: "Edit", glob: "Find files", grep: "Search", bash: "Command",
  task: "Sub-task", webfetch: "Web page", todowrite: "To-do list", skill: "Skill", question: "Question", compress: "Compress context",
}

export function sortMsgs(ms: Msg[]): Msg[] {
  return [...ms].sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
}

export function upsertPart(ms: Msg[], part: OcPart): Msg[] {
  const i = ms.findIndex((m) => m.info.id === part.messageID)
  if (i < 0) {
    const info = { id: part.messageID, role: "assistant" as const, sessionID: part.sessionID, time: { created: Date.now() } }
    return sortMsgs([...ms, { info, parts: [part] }])
  }
  const m = ms[i]!
  const j = m.parts.findIndex((p) => p.id === part.id)
  const parts = j < 0 ? [...m.parts, part] : m.parts.map((p, k) => (k === j ? part : p))
  return ms.map((x, k) => (k === i ? { ...x, parts } : x))
}

export function applyDelta(ms: Msg[], p: { messageID: string; partID: string; field: string; delta: string; sessionID: string }): Msg[] {
  const m = ms.find((x) => x.info.id === p.messageID)
  const part = m?.parts.find((x) => x.id === p.partID)
  const base: OcPart = part ?? { id: p.partID, messageID: p.messageID, sessionID: p.sessionID, type: "text", text: "" }
  const prev = (base as unknown as Record<string, unknown>)[p.field]
  return upsertPart(ms, { ...base, [p.field]: (typeof prev === "string" ? prev : "") + p.delta } as OcPart)
}


// ---- messages ----------------------------------------------------------------

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** Under the last answer of a finished turn: how long it took and the tokens. */
export function turnFooter(all: Msg[], i: number, busy: boolean): string | null {
  const m = all[i]!
  if (m.info.role !== "assistant" || !m.info.time.completed) return null
  const next = all[i + 1]
  if (next ? next.info.role !== "user" : busy) return null
  let start = i
  while (start > 0 && all[start - 1]!.info.role === "assistant") start--
  const user = all[start - 1]
  const turn = all.slice(start, i + 1)
  const out = turn.reduce((a, x) => a + (x.info.tokens?.output ?? 0) + (x.info.tokens?.reasoning ?? 0), 0)
  const t = m.info.tokens
  const context = t ? t.input + t.cache.read + t.cache.write : 0
  const bits = []
  if (user) bits.push(`Took ${Math.max(0, Math.round((m.info.time.completed - user.info.time.created) / 1000))} s`)
  if (turn.length > 1) bits.push(`${turn.length} steps`)
  if (context) bits.push(`context ${k(context)} tokens`)
  if (out) bits.push(`${k(out)} out`)
  return bits.length ? bits.join(" · ") : null
}

export function Message({ m, footer }: { m: Msg; footer: string | null }) {
  const parts = m.parts.filter((p) => !(p as { synthetic?: boolean }).synthetic)
  const err = (m.info as { error?: { name?: string; data?: { message?: string } } }).error
  if (m.info.role === "user") {
    const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").trim()
    if (!text) return null
    return <div className="chat-msg is-user"><div className="chat-bubble">{text}</div></div>
  }
  const shown = parts.filter((p) => ["text", "reasoning", "tool"].includes(p.type))
  return (
    <div className="chat-msg is-assistant">
      {shown.map((p) => <Part key={p.id} p={p} />)}
      {err && err.name !== "MessageAbortedError" && <div className="form-alert">{err.data?.message ?? err.name}</div>}
      {err?.name === "MessageAbortedError" && <div className="chat-note">Aborted.</div>}
      {footer && <div className="chat-turn">{footer}</div>}
    </div>
  )
}

function Part({ p }: { p: OcPart }) {
  if (p.type === "text") return p.text?.trim() ? <div className="chat-text">{renderText(p.text)}</div> : null
  if (p.type === "reasoning") {
    const t = p.text ?? ""
    if (!t.trim()) return null
    return (
      <details className="chat-thinking">
        <summary>Thinking ({t.length} characters)</summary>
        <div className="chat-thinking-text">{t}</div>
      </details>
    )
  }
  return <ToolRow p={p} />
}

function toolSummary(p: OcPart): string {
  const i = p.state?.input ?? {}
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "")
  return s("command") || s("filePath") || s("pattern") || p.state?.title || s("description") || s("url") || ""
}

function ToolRow({ p }: { p: OcPart }) {
  const st = p.state?.status ?? "pending"
  const live = typeof p.state?.metadata?.output === "string" ? (p.state.metadata.output as string) : ""
  const body = st === "error" ? p.state?.error ?? "" : st === "completed" ? p.state?.output ?? "" : live
  const exit = p.state?.metadata?.exit
  const label = TOOL_LABEL[p.tool ?? ""] ?? p.tool ?? "Tool"
  // A tool cut short by Abort ends as an error; it was stopped, not broken.
  const stopped = st === "error" && /abort/i.test(p.state?.error ?? "")
  const status = stopped ? "stopped"
    : st === "running" ? (p.tool === "question" ? "waiting for your answer" : "running…")
    : st === "pending" ? "waiting" : st === "error" ? "failed"
    : typeof exit === "number" && exit !== 0 ? `exit ${exit}` : "done"
  return (
    <details className={`chat-tool is-${stopped ? "stopped" : st}`} open={st === "running" && !!live}>
      <summary>
        <span className="chat-tool-name">{label}</span>
        <span className="chat-tool-what data-mono">{toolSummary(p)}</span>
        <span className="chat-tool-status">{status}</span>
      </summary>
      {body ? <pre className="logs-body chat-tool-out">{body.length > 20000 ? body.slice(0, 20000) + "\n…" : body}</pre> : null}
    </details>
  )
}

/** Plain text with a little markdown: ``` code blocks, `inline code`,
 *  **bold**, and # headings (shown bold). Lists stay as typed. Nothing else is
 *  interpreted, and nothing becomes HTML. */
function renderText(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const blocks = text.split(/```[^\n]*\n?/)
  blocks.forEach((b, i) => {
    if (i % 2 === 1) { out.push(<pre key={i} className="logs-body chat-code">{b.replace(/\n$/, "")}</pre>); return }
    const lines = b.split("\n")
    out.push(
      <span key={i}>
        {lines.map((line, li) => {
          const h = /^#{1,6}\s+(.*)$/.exec(line)
          return (
            <span key={li}>
              {h ? <strong className="chat-h">{inline(h[1]!)}</strong> : inline(line)}
              {li < lines.length - 1 ? "\n" : null}
            </span>
          )
        })}
      </span>,
    )
  })
  return out
}

export function inline(s: string): ReactNode[] {
  return s.split(/(`[^`\n]+`)/).flatMap((x, k) => {
    if (x.startsWith("`") && x.endsWith("`") && x.length > 2) return [<code key={k}>{x.slice(1, -1)}</code>]
    return x.split(/(\*\*[^*\n]+\*\*)/).map((y, j) =>
      y.startsWith("**") && y.endsWith("**") && y.length > 4 ? <strong key={`${k}-${j}`}>{y.slice(2, -2)}</strong> : <span key={`${k}-${j}`}>{y}</span>)
  })
}

// ---- questions ---------------------------------------------------------------

export function QuestionCard({ q, onAnswer }: { q: OcQuestion; onAnswer: (answers: string[][] | null) => Promise<void> }) {
  const [picked, setPicked] = useState<string[][]>(() => q.questions.map(() => []))
  const [typed, setTyped] = useState<string[]>(() => q.questions.map(() => ""))
  const [busy, setBusy] = useState(false)
  const toggle = (qi: number, label: string, multiple: boolean) =>
    setPicked((ps) => ps.map((p, i) => (i !== qi ? p : multiple ? (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]) : [label])))
  const answers = picked.map((p, i) => (typed[i]!.trim() ? [...p, typed[i]!.trim()] : p))
  const complete = answers.every((a) => a.length > 0)
  return (
    <div className="chat-question">
      <div className="chat-question-head">The model asks</div>
      {q.questions.map((qq, qi) => (
        <div key={qi} className="chat-question-item">
          <div className="data-strong">{qq.question}</div>
          <div className="chat-question-options">
            {qq.options.map((o) => (
              <button key={o.label} type="button" title={o.description}
                className={`console-chip${picked[qi]!.includes(o.label) ? " is-active" : ""}`}
                onClick={() => toggle(qi, o.label, !!qq.multiple)}>{o.label}</button>
            ))}
          </div>
          {qq.custom !== false && (
            <input className="form-input" placeholder="Or type an answer" value={typed[qi]}
              onChange={(e) => setTyped((ts) => ts.map((t, i) => (i === qi ? e.target.value : t)))} />
          )}
        </div>
      ))}
      <div className="chat-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={busy || !complete}
          onClick={async () => { setBusy(true); await onAnswer(answers); setBusy(false) }}>Answer</button>
        <button type="button" className="btn btn-small" disabled={busy}
          onClick={async () => { setBusy(true); await onAnswer(null); setBusy(false) }}>Dismiss</button>
      </div>
    </div>
  )
}

// ---- markdown for stories (survey, plan, steps) ---------------------------------

/** Markdown as the plan files use it: ``` code blocks, | tables |, # headings,
 *  `- ` lists (kept as typed), **bold** and `code`. Nothing becomes HTML. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const out: ReactNode[] = []
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push(<div key={`p${out.length}`} className="md-p">{para.map((l, i) => <span key={i}>{inline(l)}{i < para.length - 1 ? "\n" : null}</span>)}</div>)
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (/^\s*```/.test(l)) {
      flush()
      const body: string[] = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) body.push(lines[i]!)
      out.push(<pre key={`c${out.length}`} className="logs-body md-code">{body.join("\n")}</pre>)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      flush()
      const rows: string[][] = []
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!); i++) {
        if (/^\s*\|[\s\-|:]+\|\s*$/.test(lines[i]!)) continue
        rows.push(lines[i]!.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()))
      }
      i--
      const [head, ...body] = rows
      out.push(
        <div key={`t${out.length}`} className="md-table-wrap">
          <table className="data-table md-table">
            {head && <thead><tr>{head.map((c, k) => <th key={k}>{inline(c)}</th>)}</tr></thead>}
            <tbody>{body.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l)
    if (h) { flush(); out.push(<div key={`h${out.length}`} className={`md-h md-h${h[1]!.length}`}>{inline(h[2]!)}</div>); continue }
    if (!l.trim()) { flush(); continue }
    para.push(l)
  }
  flush()
  return <div className={`md${className ? ` ${className}` : ""}`}>{out}</div>
}
