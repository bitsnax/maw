"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { abortSession, answerQuestion, sendPrompt } from "../projects/session-actions"
import { consoleStop } from "../machines/actions"
import {
  newWorkspaceSession, removeWorkspaceSession, runWorkspaceCommand, settleWorkspaceRun, workspaceRuns, workspaceSnapshot,
  type WsCommand, type WsSnapshot,
} from "./actions"
import { Message, QuestionCard, turnFooter } from "./conversation"
import { useSession } from "./useSession"
import StoryView from "./StoryView"
import { useSounds } from "./sounds"
import type { RunLine, RunView } from "@/lib/command-runs"
import type { CommandStatus, OutputLine } from "@/lib/machines"

// The Dashboard workspace, where the work happens:
//   toolbar   project picker, session picker (or a new session), the
//             project's command buttons, Working · N s and Abort
//   output    the session's conversation as it happens, with button runs
//             (never sent to OpenCode) in time order among the messages
//   prompt    sticky at the bottom; with no session open, the first prompt
//             starts one (titled from the prompt)
// The second picker also holds the project's stories (written on the project
// page): picking one shows the story — phases, steps, checklists — in the
// output window, and its branch and key fill the buttons' {branch} and
// {story}.
// The selection is kept in the address (?project=…&session=… or &story=…).
// The toolbar's live states are asked again every 5 s.

const EVERY = 5000
const PH = /(["']?)\{([A-Za-z][A-Za-z0-9_]{0,30})\}\1/g
const names = (c: string) => [...new Set([...c.matchAll(PH)].map((m) => m[2]!))]

function stateLabel(l: { state: string } | null): string {
  return !l ? "" : l.state === "waiting" ? "Waiting for you" : l.state === "retry" ? "Retrying" : "Working"
}

export default function Workspace({ initial, initialSession, initialStory }: { initial: WsSnapshot; initialSession: string | null; initialStory: string | null }) {
  const [snap, setSnap] = useState(initial)
  const [projectId, setProjectId] = useState(initial.project?.id ?? null)
  const [sessionId, setSessionId] = useState<string | null>(
    initialSession && initial.sessions.some((s) => s.id === initialSession) ? initialSession : null)
  const [storyId, setStoryId] = useState<string | null>(
    initialStory && initial.stories.some((s) => s.id === initialStory) ? initialStory : null)

  // Button runs, kept for one project + session; another selection starts empty.
  const runKey = `${projectId ?? ""}/${sessionId ?? ""}/${storyId ?? ""}`
  const [runState, setRunState] = useState<{ key: string; runs: RunView[] }>({ key: "", runs: [] })
  const runs = useMemo(() => (runState.key === runKey ? runState.runs : []), [runState, runKey])
  const setRuns = useCallback((f: (xs: RunView[]) => RunView[]) =>
    setRunState((p) => ({ key: runKey, runs: f(p.key === runKey ? p.runs : []) })), [runKey])
  const [ask, setAsk] = useState<{ cmd: WsCommand; values: Record<string, string> } | null>(null)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const sess = useSession(sessionId)
  const sound = useSounds(snap)
  const outRef = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  const askRef = useRef<HTMLDialogElement | null>(null)
  const project = snap.project
  const current = snap.sessions.find((s) => s.id === sessionId) ?? null
  const story = snap.stories.find((s) => s.id === storyId) ?? null

  // Keep the address in step with the selection (no navigation).
  useEffect(() => {
    const q = new URLSearchParams()
    if (projectId) q.set("project", projectId)
    if (sessionId) q.set("session", sessionId)
    if (storyId) q.set("story", storyId)
    window.history.replaceState(null, "", q.toString() ? `/?${q}` : "/")
  }, [projectId, sessionId, storyId])

  const refresh = useCallback(async (pid: string | null) => {
    const r = await workspaceSnapshot(pid)
    if (r.ok) setSnap(r.data)
    return r
  }, [])

  // Live states, every 5 s while the tab is visible.
  useEffect(() => {
    let stopped = false
    let t: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (!document.hidden) { try { await refresh(projectId) } catch { /* next tick */ } }
      if (!stopped) t = setTimeout(tick, EVERY)
    }
    t = setTimeout(tick, EVERY)
    return () => { stopped = true; if (t) clearTimeout(t) }
  }, [projectId, refresh])

  // Button runs of this session (or of "no session").
  useEffect(() => {
    let cancelled = false
    if (!projectId) return
    const key = `${projectId}/${sessionId ?? ""}/${storyId ?? ""}`
    workspaceRuns(projectId, sessionId, storyId).then((r) => { if (!cancelled && r.ok) setRunState({ key, runs: r.data }) })
    return () => { cancelled = true }
  }, [projectId, sessionId, storyId])

  useEffect(() => { if (ask) askRef.current?.showModal(); else askRef.current?.close() }, [ask])

  // When the open session starts or stops working, the pickers' states follow at once.
  useEffect(() => {
    if (!projectId) return
    const t = setTimeout(() => void refresh(projectId), 300)
    return () => clearTimeout(t)
  }, [sess.busy, projectId, refresh])
  useEffect(() => {
    if (!sess.busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [sess.busy])

  // Follow the output unless the reader scrolled up.
  const onScroll = () => { const el = outRef.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120 }
  useEffect(() => { const el = outRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight }, [sess.msgs, sess.questions, runs])

  // ---- selection ----
  async function pickProject(id: string) {
    setProjectId(id)
    setSessionId(null)
    setStoryId(null)
    setConfirmRemove(false)
    setNote(null)
    stick.current = true
    await refresh(id)
  }
  /** The second picker: "" (new session), a session id, or "story:<id>". */
  function pickSession(id: string) {
    if (id.startsWith("story:")) { setStoryId(id.slice(6)); setSessionId(null) }
    else { setSessionId(id || null); setStoryId(null) }
    setConfirmRemove(false)
    setNote(null)
    stick.current = true
  }
  async function jumpTo(pid: string, sid: string) {
    setProjectId(pid)
    await refresh(pid)
    pickSession(sid)
  }

  // ---- prompt ----
  async function send() {
    const t = draft.trim()
    if (!t || sending || !project) return
    setSending(true)
    setNote(null)
    sess.setError(null)
    let sid = sessionId
    if (!sid) {
      const title = t.split("\n")[0]!.slice(0, 60)
      const n = await newWorkspaceSession(project.id, title)
      if (!n.ok) { setSending(false); setNote(n.message); return }
      sid = n.data.id
    }
    const r = await sendPrompt(sid, t)
    setSending(false)
    if (!r.ok) { setNote(r.message); return }
    setDraft("")
    stick.current = true
    if (sid !== sessionId) { setSessionId(sid); void refresh(project.id) } else sess.markBusy()
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send() }
  }
  async function abort() {
    if (!sessionId) return
    const r = await abortSession(sessionId)
    if (!r.ok) setNote(r.message)
  }
  async function remove() {
    if (!sessionId || !project) return
    const r = await removeWorkspaceSession(sessionId)
    if (!r.ok) { setNote(r.message); return }
    setConfirmRemove(false)
    setSessionId(null)
    await refresh(project.id)
  }

  // ---- command buttons ----
  function press(c: WsCommand) {
    const need = names(c.command)
    const fixed: Record<string, string> = story ? { story: story.key, ...(story.branch ? { branch: story.branch } : {}) } : {}
    if (need.length && !need.every((n) => (fixed[n] ?? "").trim())) {
      setAsk({ cmd: c, values: Object.fromEntries(need.map((n) => [n, fixed[n] ?? ""])) })
      return
    }
    void start(c, Object.fromEntries(need.map((n) => [n, fixed[n]!])))
  }
  async function start(c: WsCommand, values: Record<string, string>) {
    setAsk(null)
    setNote(null)
    stick.current = true
    const r = await runWorkspaceCommand(c.id, values, sessionId, storyId)
    if (!r.ok) { setNote(r.message); return }
    setRuns((xs) => [...xs, r.data])
  }
  const settled = useCallback((run: RunView) => setRuns((xs) => xs.map((x) => (x.id === run.id ? run : x))), [setRuns])

  // ---- the output: messages and runs in time order ----
  const timeline = useMemo(() => {
    const items: ({ k: "m"; t: number; i: number } | { k: "r"; t: number; run: RunView })[] = []
    ;(sess.msgs ?? []).forEach((m, i) => items.push({ k: "m", t: m.info.time.created, i }))
    runs.forEach((run) => items.push({ k: "r", t: Date.parse(run.startedAt), run }))
    return items.sort((a, b) => a.t - b.t)
  }, [sess.msgs, runs])

  const seconds = sess.busySince ? Math.max(0, Math.round((now - sess.busySince) / 1000)) : 0
  const elsewhereCount = snap.elsewhere.length

  if (!project) {
    return (
      <div className="ws ws-none">
        <p className="app-empty">No projects yet. <Link href="/projects/new" className="data-link">Add a project</Link> (a folder on one of your machines), then work in it here.</p>
      </div>
    )
  }

  return (
    <div className="ws">
      <div className="ws-bar">
        <div className="ws-pickers">
          <select className="form-input ws-select" aria-label="Project" value={project.id} onChange={(e) => void pickProject(e.target.value)}>
            {snap.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name} — {p.machineName}{p.active ? ` · ${p.active} active` : ""}</option>
            ))}
          </select>
          <select className="form-input ws-select ws-session" aria-label="Session or story" value={storyId ? `story:${storyId}` : sessionId ?? ""} onChange={(e) => pickSession(e.target.value)}>
            <option value="">+ New session</option>
            {snap.stories.length > 0 && (
              <optgroup label="Stories">
                {snap.stories.map((t) => <option key={t.id} value={`story:${t.id}`}>Story {t.number}: {t.title} · {t.statusLabel}</option>)}
              </optgroup>
            )}
            {snap.sessions.length > 0 && (
              <optgroup label="Sessions">
                {snap.sessions.map((s) => (
                  <option key={s.id} value={s.id}>{s.live ? `● ${stateLabel(s.live)} · ` : ""}{s.title}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="ws-commands">
          {snap.commands.map((c) => (
            <button key={c.id} type="button" className="btn btn-small ws-cmd" title={c.command} onClick={() => press(c)}>{c.title}</button>
          ))}
        </div>
        <div className="ws-state">
          <button type="button" className={`ws-sound${sound.on ? " is-on" : ""}`} onClick={sound.toggle}
            title={sound.on ? "Sounds on: a tone when a story or session needs you, fails or finishes. Click to turn off." : "Sounds off. Click to turn on."}
            aria-label={sound.on ? "Turn sounds off" : "Turn sounds on"} aria-pressed={sound.on}>
            {sound.on ? "🔔" : "🔕"}
          </button>
          {elsewhereCount > 0 && (
            <details className="ws-elsewhere">
              <summary>{elsewhereCount} active elsewhere</summary>
              <div className="ws-menu">
                {snap.elsewhere.map((e) => (
                  <button key={e.id} type="button" className="ws-menu-item" onClick={() => void jumpTo(e.projectId, e.id)}>
                    <span className={`session-state is-${e.live.state}`}>{stateLabel(e.live)}</span> {e.projectName} · {e.title}
                  </button>
                ))}
              </div>
            </details>
          )}
          {sessionId && <span className={`chat-live is-${sess.live}`}>{sess.live === "live" ? "Live" : sess.live === "lost" ? "Reconnecting…" : "Connecting…"}</span>}
          {sess.busy ? (
            <>
              <span className="chat-working">{sess.questions.length ? "Waiting for you" : `Working · ${seconds} s`}</span>
              <button type="button" className="btn btn-small btn-danger" onClick={() => void abort()}>Abort</button>
            </>
          ) : sessionId ? <span className="ws-ready">Ready</span> : null}
        </div>
      </div>

      <div className="ws-out" ref={outRef} onScroll={onScroll}>
        <div className="ws-inner">
          <div className="ws-head">
            <span className="ws-title">{story ? `Story ${story.number}: ${story.title}` : current ? current.title : "New session"}</span>
            <span className="ws-where">in <span className="data-mono">{project.root}</span> on {project.machineName}</span>
            {current && (confirmRemove ? (
              <span className="ws-remove">
                Remove this session and its conversation?{" "}
                <button type="button" className="btn btn-small btn-danger" onClick={() => void remove()}>Remove</button>{" "}
                <button type="button" className="btn btn-small" onClick={() => setConfirmRemove(false)}>Cancel</button>
              </span>
            ) : (
              <button type="button" className="data-link ws-remove ws-linkbtn" onClick={() => setConfirmRemove(true)}>Remove session</button>
            ))}
          </div>
          {snap.unreachable && <div className="form-alert spaced">maw-opencode did not answer: {snap.unreachable}</div>}

          {story && <StoryView storyId={story.id} onOpenSession={(id) => { pickSession(id); void refresh(projectId) }} />}

          {!sessionId && !story && timeline.length === 0 && (
            <p className="app-empty ws-hint">Write the first prompt below to start a session in {project.name}. The command buttons above run in {project.root} on {project.machineName}; their output shows here and is never sent to the model.</p>
          )}
          {sessionId && sess.msgs === null && !sess.error && <p className="app-empty">Loading the conversation…</p>}

          <div className="chat-list">
            {timeline.map((it) => it.k === "m"
              ? <Message key={sess.msgs![it.i]!.info.id} m={sess.msgs![it.i]!} footer={turnFooter(sess.msgs!, it.i, sess.busy)} />
              : <RunBlock key={it.run.id} run={it.run} onSettled={settled} onError={setNote} />)}
          </div>

          {sessionId && sess.questions.map((q) => (
            <QuestionCard key={q.id} q={q} onAnswer={async (answers) => {
              const r = await answerQuestion(sessionId, q.id, answers)
              if (r.ok) sess.dropQuestion(q.id)
              else sess.setError(r.message)
            }} />
          ))}
          {sess.error && <div className="form-alert chat-error">{sess.error}</div>}
          {note && <div className="form-alert chat-error">{note}</div>}
        </div>
      </div>

      <div className="ws-compose">
        <div className="ws-inner ws-compose-row">
          <textarea
            className="form-input chat-input ws-input" rows={2} value={draft} aria-label="Prompt" disabled={!!story}
            placeholder={story ? "MAW works a story in its own sessions (listed under Sessions); open one, or pick + New session, to prompt the model."
              : !sessionId ? `New session in ${project.name}: write a prompt. Enter sends, Shift+Enter adds a line.`
              : sess.busy ? "Write the next prompt; it is sent after the current turn." : "Write a prompt. Enter sends, Shift+Enter adds a line."}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey}
          />
          <button type="button" className="btn btn-primary ws-send" onClick={() => void send()} disabled={sending || !draft.trim() || !!story}>
            {sending ? "Sending…" : sess.busy ? "Queue" : "Send"}
          </button>
        </div>
      </div>

      <dialog ref={askRef} className="pcmd-dialog" onClose={() => setAsk(null)}>
        {ask && (
          <form className="pcmd-form" onSubmit={(e) => { e.preventDefault(); void start(ask.cmd, ask.values) }}>
            <h3 className="pcmd-dialog-title">{ask.cmd.title}</h3>
            <p className="pcmd-help data-mono">{ask.cmd.command}</p>
            {Object.keys(ask.values).map((n, i) => (
              <div key={n}>
                <label className="form-label" htmlFor={`ws-v-${n}`}>{n}</label>
                <input id={`ws-v-${n}`} className="form-input" value={ask.values[n]} autoFocus={i === 0}
                  onChange={(e) => setAsk({ ...ask, values: { ...ask.values, [n]: e.target.value } })} />
              </div>
            ))}
            <div className="pcmd-actions">
              <button type="button" className="btn" onClick={() => setAsk(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={Object.values(ask.values).some((v) => !v.trim())}>Run</button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  )
}

// ---- one button run in the output ----------------------------------------------

function outcomeText(r: { state: string; exitCode: number | null; durationMs: number | null }): string {
  const s = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`)
  switch (r.state) {
    case "exited": return `exit ${r.exitCode}${r.durationMs !== null ? ` · ${s(r.durationMs)}` : ""}`
    case "stopped": return `stopped${r.durationMs !== null ? ` · ${s(r.durationMs)}` : ""}`
    case "timed_out": return "timed out"
    case "failed": return "failed"
    default: return "running"
  }
}

function RunBlock({ run, onSettled, onError }: { run: RunView; onSettled: (r: RunView) => void; onError: (m: string) => void }) {
  const [live, setLive] = useState<RunLine[]>([])
  const [stopping, setStopping] = useState(false)
  const [open, setOpen] = useState(true)
  const running = run.state === "running"

  useEffect(() => {
    if (!running) return
    const ac = new AbortController()
    let last = 0
    let failures = 0
    const settle = async () => { const r = await settleWorkspaceRun(run.id); if (r.ok && !ac.signal.aborted) onSettled(r.data) }
    ;(async () => {
      while (!ac.signal.aborted) {
        try {
          const res = await fetch(`/api/machines/${run.machineId}/exec/${run.jobId}?after=${last}`, { signal: ac.signal, cache: "no-store" })
          if (!res.ok) throw new Error(`(${res.status})`)
          const reader = res.body!.getReader()
          const dec = new TextDecoder()
          let buf = ""
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            const batch: RunLine[] = []
            let nl: number
            while ((nl = buf.indexOf("\n")) >= 0) {
              const raw = buf.slice(0, nl)
              buf = buf.slice(nl + 1)
              if (!raw.trim()) continue
              const e = JSON.parse(raw) as { type: string } & OutputLine & CommandStatus
              if (e.type === "line") { last = e.seq; if (!e.login) batch.push({ s: e.stream === "stderr" ? "e" : "o", t: e.text }) }
              else if (e.type === "end") { if (batch.length) setLive((xs) => [...xs, ...batch]); await settle(); return }
              else if (e.type === "error") throw new Error("stream")
            }
            if (batch.length) { failures = 0; setLive((xs) => [...xs, ...batch].slice(-500)) }
          }
          throw new Error("ended")
        } catch {
          if (ac.signal.aborted) return
          if (++failures > 3) { await settle(); return }
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    })()
    return () => ac.abort()
  }, [running, run.id, run.machineId, run.jobId, onSettled])

  async function stop() {
    setStopping(true)
    const r = await consoleStop(run.machineId, run.jobId)
    if (!r.ok) { onError(r.message); setStopping(false) }
  }

  const lines = running ? live : run.lines ?? []
  const ok = run.state === "exited" && run.exitCode === 0
  return (
    <div className={`ws-run is-${running ? "running" : ok ? "ok" : run.state === "stopped" ? "stopped" : "bad"}`}>
      <div className="ws-run-head">
        <button type="button" className="ws-run-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="ws-run-title">{run.title}</span>
          <span className="data-mono ws-run-cmd">{run.command}</span>
        </button>
        <span className="ws-run-status">{running ? (stopping ? "stopping…" : "running…") : outcomeText(run)}</span>
        {running && <button type="button" className="btn btn-small btn-danger" disabled={stopping} onClick={() => void stop()}>Stop</button>}
      </div>
      {open && (
        <pre className="logs-body ws-run-out">
          {lines.length === 0 ? <span className="log-time">{running ? "No output yet." : "(no output)"}</span>
            : lines.map((l, i) => <div key={i} className={l.s === "e" ? "log-err" : undefined}>{l.t || " "}</div>)}
        </pre>
      )}
    </div>
  )
}
