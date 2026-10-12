"use client"

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { abortSession, answerQuestion, deleteSession, loadSession, sendPrompt } from "../../../session-actions"
import type { OcMessage, OcPart, OcQuestion } from "@/lib/opencode"

// One OpenCode session: the conversation as it happens.
//
// The page loads the whole conversation once (loadSession), then follows
// /api/sessions/<id>/events (NDJSON) and applies each event:
//   message.updated / message.part.updated   insert or replace
//   message.part.delta                       append streamed text to a part
//   session.status / session.idle            working or not
//   question.asked / replied / rejected      question cards
// After a broken connection it reconnects and loads the conversation again,
// so nothing missed in between is lost.
//
// A prompt can be sent while the model is working: OpenCode queues it and
// answers after the current turn.

type Msg = { info: OcMessage["info"]; parts: OcPart[] }
type Ev = { type: string; properties?: Record<string, unknown>; message?: string }

const TOOL_LABEL: Record<string, string> = {
  read: "Read", write: "Write", edit: "Edit", glob: "Find files", grep: "Search", bash: "Command",
  task: "Sub-task", webfetch: "Web page", todowrite: "To-do list", skill: "Skill", question: "Question", compress: "Compress context",
}

function sortMsgs(ms: Msg[]): Msg[] {
  return [...ms].sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
}

function upsertPart(ms: Msg[], part: OcPart): Msg[] {
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

function applyDelta(ms: Msg[], p: { messageID: string; partID: string; field: string; delta: string; sessionID: string }): Msg[] {
  const m = ms.find((x) => x.info.id === p.messageID)
  const part = m?.parts.find((x) => x.id === p.partID)
  const base: OcPart = part ?? { id: p.partID, messageID: p.messageID, sessionID: p.sessionID, type: "text", text: "" }
  const prev = (base as unknown as Record<string, unknown>)[p.field]
  return upsertPart(ms, { ...base, [p.field]: (typeof prev === "string" ? prev : "") + p.delta } as OcPart)
}

export default function SessionView({ sessionId, title, root, machineName }: {
  sessionId: string; title: string; root: string; machineName: string
}) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [busySince, setBusySince] = useState<number | null>(null)
  const [questions, setQuestions] = useState<OcQuestion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<"connecting" | "live" | "lost">("connecting")
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [confirmRemove, setConfirmRemove] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)

  // Load, then follow the events; on a broken stream, reload and reconnect.
  useEffect(() => {
    let stopped = false
    const ac = new AbortController()
    const load = async () => {
      const r = await loadSession(sessionId)
      if (stopped) return
      if (!r.ok) { setError(r.message); return }
      setMsgs(sortMsgs(r.data.messages))
      setQuestions(r.data.questions)
      setBusy(r.data.busy)
      setBusySince((s) => (r.data.busy ? s ?? Date.now() : null))
    }
    const apply = (e: Ev) => {
      const p = e.properties ?? {}
      switch (e.type) {
        case "message.updated": {
          const info = p.info as Msg["info"]
          setMsgs((ms) => {
            const cur = ms ?? []
            const i = cur.findIndex((m) => m.info.id === info.id)
            return i < 0 ? sortMsgs([...cur, { info, parts: [] }]) : cur.map((m, k) => (k === i ? { ...m, info } : m))
          })
          break
        }
        case "message.part.updated": setMsgs((ms) => upsertPart(ms ?? [], p.part as OcPart)); break
        case "message.part.delta": setMsgs((ms) => applyDelta(ms ?? [], p as never)); break
        case "message.removed": setMsgs((ms) => (ms ?? []).filter((m) => m.info.id !== p.messageID)); break
        case "message.part.removed":
          setMsgs((ms) => (ms ?? []).map((m) => (m.info.id === p.messageID ? { ...m, parts: m.parts.filter((x) => x.id !== p.partID) } : m)))
          break
        case "session.status": {
          const t = (p.status as { type?: string } | undefined)?.type
          const b = t === "busy" || t === "retry"
          setBusy(b)
          setBusySince((s) => (b ? s ?? Date.now() : null))
          break
        }
        case "session.idle": setBusy(false); setBusySince(null); break
        case "session.error": {
          const err = p.error as { data?: { message?: string }; name?: string } | undefined
          if (err?.name !== "MessageAbortedError") setError(err?.data?.message ?? err?.name ?? "The session reported an error.")
          break
        }
        case "question.asked": setQuestions((qs) => [...qs.filter((q) => q.id !== p.id), p as unknown as OcQuestion]); break
        case "question.replied":
        case "question.rejected": setQuestions((qs) => qs.filter((q) => q.id !== p.requestID)); break
      }
    }
    const follow = async () => {
      let first = true
      while (!stopped) {
        try {
          const res = await fetch(`/api/sessions/${sessionId}/events`, { signal: ac.signal, cache: "no-store" })
          if (!res.ok) {
            const b = (await res.json().catch(() => null)) as { message?: string } | null
            throw new Error(b?.message ?? `The live view could not be opened (${res.status}).`)
          }
          const reader = res.body!.getReader()
          const dec = new TextDecoder()
          let buf = ""
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let nl: number
            while ((nl = buf.indexOf("\n")) >= 0) {
              const raw = buf.slice(0, nl)
              buf = buf.slice(nl + 1)
              if (!raw.trim()) continue
              const e = JSON.parse(raw) as Ev
              if (e.type === "ready") {
                setLive("live")
                // Subscribed: load now, so nothing between load and subscribe is missed.
                if (!first) await load()
                first = false
              } else if (e.type === "error") throw new Error(e.message)
              else apply(e)
            }
          }
          throw new Error("The live view ended.")
        } catch {
          if (stopped) return
          setLive("lost")
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    }
    void load().then(() => follow())
    return () => { stopped = true; ac.abort() }
  }, [sessionId])

  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busy])

  // Follow the conversation unless the reader scrolled up.
  useEffect(() => {
    const onScroll = () => { stick.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120 }
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])
  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: "end" })
  }, [msgs, questions])

  async function send() {
    const t = draft.trim()
    if (!t || sending) return
    setSending(true)
    setError(null)
    const r = await sendPrompt(sessionId, t)
    setSending(false)
    if (r.ok) { setDraft(""); stick.current = true; setBusy(true); setBusySince((s) => s ?? Date.now()) }
    else setError(r.message)
  }
  async function abort() {
    const r = await abortSession(sessionId)
    if (!r.ok) setError(r.message)
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send() }
  }

  const seconds = busySince ? Math.max(0, Math.round((now - busySince) / 1000)) : 0

  return (
    <div className="chat">
      <div className="chat-meta">
        <span className={`chat-live is-${live}`}>{live === "live" ? "Live" : live === "lost" ? "Reconnecting…" : "Connecting…"}</span>
        <span>Works in <span className="data-mono">{root}</span> on {machineName}</span>
        {confirmRemove ? (
          <span className="chat-remove">
            Remove &quot;{title}&quot; and its conversation?{" "}
            <button type="button" className="btn btn-small btn-danger" onClick={async () => { const r = await deleteSession(sessionId); if (!r.ok) setError(r.message) }}>Remove</button>{" "}
            <button type="button" className="btn btn-small" onClick={() => setConfirmRemove(false)}>Cancel</button>
          </span>
        ) : (
          <button type="button" className="btn btn-small chat-remove" onClick={() => setConfirmRemove(true)}>Remove session</button>
        )}
      </div>

      {msgs === null && !error && <p className="app-empty">Loading the conversation…</p>}
      {msgs !== null && msgs.length === 0 && <p className="app-empty">No messages yet. Write the first prompt below.</p>}

      <div className="chat-list">
        {(msgs ?? []).map((m) => <Message key={m.info.id} m={m} />)}
      </div>

      {questions.map((q) => (
        <QuestionCard key={q.id} q={q} onAnswer={async (answers) => {
          const r = await answerQuestion(sessionId, q.id, answers)
          if (r.ok) setQuestions((qs) => qs.filter((x) => x.id !== q.id))
          else setError(r.message)
        }} />
      ))}

      {error && <div className="form-alert chat-error">{error}</div>}

      <div className="chat-compose" ref={endRef}>
        <div className="chat-status">
          {busy ? <span className="chat-working">Working · {seconds} s</span> : <span>Ready</span>}
          {busy && <button type="button" className="btn btn-small btn-danger" onClick={abort}>Abort</button>}
        </div>
        <textarea
          className="form-input chat-input" rows={3} value={draft} placeholder={busy ? "Write the next prompt; it is sent after the current turn." : "Write a prompt. Enter sends, Shift+Enter adds a line."}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} aria-label="Prompt"
        />
        <div className="chat-actions">
          <button type="button" className="btn btn-primary" onClick={() => void send()} disabled={sending || !draft.trim()}>
            {sending ? "Sending…" : busy ? "Queue" : "Send"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- messages ----------------------------------------------------------------

function Message({ m }: { m: Msg }) {
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

/** Plain text with ``` code blocks and `inline code`; nothing else is interpreted. */
function renderText(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const blocks = text.split(/```[^\n]*\n?/)
  blocks.forEach((b, i) => {
    if (i % 2 === 1) { out.push(<pre key={i} className="logs-body chat-code">{b.replace(/\n$/, "")}</pre>); return }
    const bits = b.split(/(`[^`\n]+`)/)
    out.push(
      <span key={i}>
        {bits.map((x, k) => (x.startsWith("`") && x.endsWith("`") && x.length > 2 ? <code key={k}>{x.slice(1, -1)}</code> : x))}
      </span>,
    )
  })
  return out
}

// ---- questions ---------------------------------------------------------------

function QuestionCard({ q, onAnswer }: { q: OcQuestion; onAnswer: (answers: string[][] | null) => Promise<void> }) {
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
