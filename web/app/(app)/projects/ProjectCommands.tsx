"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { consoleStatus, consoleStop } from "../machines/actions"
import {
  addProjectCommand, moveProjectCommand, removeProjectCommand, runProjectCommand, updateProjectCommand,
} from "./command-actions"
import type { CommandStatus, OutputLine } from "@/lib/machines"

// A project's command buttons: one click runs the command in the project
// folder on its machine (your git: branch, commit, push, …), with the output
// live below. Add command opens a form (title + command); Edit buttons shows
// move, edit and remove on each button. `{name}` placeholders are asked for
// when the button is pressed; `fixed` (on a story page: branch, story) fills
// them in advance.

export type Cmd = { id: string; title: string; command: string }
type Running = { jobId: string; machineId: string; title: string; command: string; startedAt: number }
type Outcome = Pick<CommandStatus, "state" | "exitCode" | "durationMs" | "timeoutSeconds" | "error">

const PH = /(["']?)\{([A-Za-z][A-Za-z0-9_]{0,30})\}\1/g
const names = (c: string) => [...new Set([...c.matchAll(PH)].map((m) => m[2]!))]
const KEEP = 2000

function outcomeText(o: Outcome): string {
  const s = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`)
  switch (o.state) {
    case "exited": return `exit ${o.exitCode} · ${s(o.durationMs)}`
    case "stopped": return `stopped · ${s(o.durationMs)}`
    case "timed_out": return `timed out after ${o.timeoutSeconds} s`
    case "failed": return `could not start: ${o.error ?? "unknown error"}`
    default: return "running"
  }
}

export default function ProjectCommands({ projectId, commands, root, machineName, fixed = {} }: {
  projectId: string; commands: Cmd[]; root: string; machineName: string; fixed?: Record<string, string>
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<{ id: string | null; title: string; command: string } | null>(null)
  const [formErr, setFormErr] = useState<{ message?: string; errors?: Record<string, string> }>({})
  const [saving, setSaving] = useState(false)
  const [ask, setAsk] = useState<{ cmd: Cmd; values: Record<string, string> } | null>(null)
  const [run, setRun] = useState<Running | null>(null)
  const [lines, setLines] = useState<OutputLine[]>([])
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [phase, setPhase] = useState<"idle" | "starting" | "running" | "stopping" | "ended">("idle")
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const formRef = useRef<HTMLDialogElement | null>(null)
  const askRef = useRef<HTMLDialogElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const outRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => { if (form) formRef.current?.showModal(); else formRef.current?.close() }, [form])
  useEffect(() => { if (ask) askRef.current?.showModal(); else askRef.current?.close() }, [ask])
  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    if (phase !== "running" && phase !== "stopping") return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [phase])
  useEffect(() => { const el = outRef.current; if (el) el.scrollTop = el.scrollHeight }, [lines])

  const active = phase === "starting" || phase === "running" || phase === "stopping"

  // ---- add / edit ----
  async function save(e: FormEvent) {
    e.preventDefault()
    if (!form) return
    setSaving(true)
    const input = { title: form.title, command: form.command }
    const r = form.id ? await updateProjectCommand(form.id, input) : await addProjectCommand(projectId, input)
    setSaving(false)
    if (!r.ok) { setFormErr({ message: r.message, errors: r.errors }); return }
    setForm(null)
    setFormErr({})
    router.refresh()
  }
  async function act(p: Promise<{ ok: boolean; message?: string }>) {
    const r = await p
    if (!r.ok) setError(r.message ?? "That did not work.")
    router.refresh()
  }

  // ---- run ----
  function press(c: Cmd) {
    if (active) return
    const need = names(c.command)
    if (need.length && !need.every((n) => (fixed[n] ?? "").trim())) {
      setAsk({ cmd: c, values: Object.fromEntries(need.map((n) => [n, fixed[n] ?? ""])) })
      return
    }
    void start(c, Object.fromEntries(need.map((n) => [n, fixed[n]!])))
  }

  async function start(c: Cmd, values: Record<string, string>) {
    setAsk(null)
    setPhase("starting")
    setError(null)
    abortRef.current?.abort()
    setRun(null)
    setLines([])
    setOutcome(null)
    const r = await runProjectCommand(c.id, values)
    if (!r.ok) { setPhase("idle"); setError(r.message); return }
    const j: Running = { jobId: r.data.jobId, machineId: r.data.machineId, title: r.data.title, command: r.data.command, startedAt: Date.parse(r.data.startedAt) }
    setRun(j)
    setLines([])
    setOutcome(null)
    setNow(Date.now())
    setPhase("running")
    void follow(j)
  }

  function finished(o: Outcome) {
    setOutcome(o)
    setPhase("ended")
  }

  async function follow(j: Running) {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    let last = 0
    let failures = 0
    while (!ac.signal.aborted) {
      try {
        const res = await fetch(`/api/machines/${j.machineId}/exec/${j.jobId}?after=${last}`, { signal: ac.signal, cache: "no-store" })
        if (!res.ok) {
          const b = (await res.json().catch(() => null)) as { message?: string } | null
          throw new Error(b?.message ?? `The output could not be opened (${res.status}).`)
        }
        const reader = res.body!.getReader()
        const dec = new TextDecoder()
        let buf = ""
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const batch: OutputLine[] = []
          let nl: number
          while ((nl = buf.indexOf("\n")) >= 0) {
            const raw = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            if (!raw.trim()) continue
            const e = JSON.parse(raw) as { type: string; message?: string } & OutputLine & CommandStatus
            if (e.type === "line") { if (!e.login) batch.push({ seq: e.seq, t: e.t, stream: e.stream, text: e.text }); last = e.seq }
            else if (e.type === "end") { if (batch.length) setLines((xs) => [...xs, ...batch].slice(-KEEP)); finished(e); return }
            else if (e.type === "error") throw new Error(e.message ?? "The output stream broke off.")
          }
          if (batch.length) { failures = 0; setLines((xs) => [...xs, ...batch].slice(-KEEP)) }
        }
        throw new Error("The output stream ended early.")
      } catch (e) {
        if (ac.signal.aborted) return
        if (++failures > 3) {
          const s = await consoleStatus(j.machineId, j.jobId)
          if (s.ok && s.data.state !== "running") finished(s.data)
          else setError(`${e instanceof Error ? e.message : String(e)} The command may still be running; Stop still works.`)
          return
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

  async function stop() {
    if (!run) return
    setPhase("stopping")
    const r = await consoleStop(run.machineId, run.jobId)
    if (!r.ok) { setError(r.message); setPhase("running"); return }
    finished(r.data)
  }

  const elapsed = run ? Math.max(0, Math.round((now - run.startedAt) / 1000)) : 0
  const ok = outcome && outcome.state === "exited" && outcome.exitCode === 0

  return (
    <div className="pcmd">
      <div className="pcmd-bar">
        {commands.map((c, i) => (
          <span key={c.id} className={`pcmd-item${editing ? " is-editing" : ""}`}>
            <button type="button" className="btn btn-small pcmd-btn" title={c.command} disabled={editing || active} onClick={() => press(c)}>{c.title}</button>
            {editing && (
              <span className="pcmd-tools">
                <button type="button" className="pcmd-tool" aria-label={`Move ${c.title} left`} disabled={i === 0} onClick={() => act(moveProjectCommand(c.id, -1))}>←</button>
                <button type="button" className="pcmd-tool" aria-label={`Move ${c.title} right`} disabled={i === commands.length - 1} onClick={() => act(moveProjectCommand(c.id, 1))}>→</button>
                <button type="button" className="pcmd-tool" aria-label={`Edit ${c.title}`} onClick={() => { setFormErr({}); setForm({ id: c.id, title: c.title, command: c.command }) }}>Edit</button>
                <button type="button" className="pcmd-tool is-danger" aria-label={`Remove ${c.title}`}
                  onClick={() => { if (confirm(`Remove the button "${c.title}"?`)) void act(removeProjectCommand(c.id)) }}>Remove</button>
              </span>
            )}
          </span>
        ))}
        <button type="button" className="btn btn-small pcmd-add" onClick={() => { setFormErr({}); setForm({ id: null, title: "", command: "" }) }}>Add command</button>
        {commands.length > 0 && (
          <button type="button" className="data-link pcmd-edit" onClick={() => setEditing((v) => !v)}>{editing ? "Done editing" : "Edit buttons"}</button>
        )}
      </div>
      {commands.length === 0 && (
        <p className="pcmd-note">No buttons yet. A button runs one command in <span className="data-mono">{root}</span> on {machineName}, for example <span className="data-mono">git status</span>.</p>
      )}

      {error && <div className="form-alert spaced">{error}</div>}

      {run && (
        <div className="logs-panel pcmd-out">
          <div className="logs-head">
            <span><strong>{run.title}</strong> <span className="data-mono console-ran">{run.command}</span></span>
            <span className="settings-actions">
              <span className={`console-status${outcome ? (ok ? " is-ok" : outcome.state === "stopped" ? "" : " is-bad") : ""}`}>
                {outcome ? outcomeText(outcome) : phase === "stopping" ? `stopping… ${elapsed} s` : `running · ${elapsed} s`}
              </span>
              {phase === "running" || phase === "stopping"
                ? <button type="button" className="btn btn-small btn-danger" disabled={phase === "stopping"} onClick={() => void stop()}>Stop</button>
                : <button type="button" className="btn btn-small" onClick={() => { setRun(null); setPhase("idle") }}>Close</button>}
            </span>
          </div>
          <pre className="logs-body console-out" ref={outRef}>
            {lines.length === 0 && <div className="log-time">{outcome ? "(no output)" : "No output yet."}</div>}
            {lines.map((l) => <div key={l.seq} className={l.stream === "stderr" ? "log-err" : undefined}>{l.text || " "}</div>)}
          </pre>
        </div>
      )}

      <dialog ref={formRef} className="pcmd-dialog" onClose={() => setForm(null)}>
        {form && (
          <form onSubmit={save} className="pcmd-form">
            <h3 className="pcmd-dialog-title">{form.id ? "Edit command" : "Add command"}</h3>
            {formErr.message && !formErr.errors?.title && !formErr.errors?.command && <div className="form-alert">{formErr.message}</div>}
            <label className="form-label" htmlFor="pcmd-title">Button title</label>
            <input id="pcmd-title" className="form-input" value={form.title} maxLength={40} autoFocus placeholder="New branch"
              onChange={(e) => setForm({ ...form, title: e.target.value })} />
            {formErr.errors?.title && <div className="form-error">{formErr.errors.title}</div>}
            <label className="form-label" htmlFor="pcmd-command">Command</label>
            <textarea id="pcmd-command" className="form-input data-mono" rows={3} value={form.command} spellCheck={false} placeholder="git checkout -b {branch}"
              onChange={(e) => setForm({ ...form, command: e.target.value })} />
            {formErr.errors?.command && <div className="form-error">{formErr.errors.command}</div>}
            <p className="pcmd-help">
              Runs in <span className="data-mono">{root}</span> on {machineName}, as the machine&apos;s user, in a login shell.
              A <span className="data-mono">{"{name}"}</span> in the command is asked for when you press the button
              (for example <span className="data-mono">git commit -m {"{message}"}</span>); on a story page,
              <span className="data-mono"> {"{branch}"}</span> and <span className="data-mono">{"{story}"}</span> are filled in for you.
            </p>
            <div className="pcmd-actions">
              <button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : form.id ? "Save" : "Create"}</button>
            </div>
          </form>
        )}
      </dialog>

      <dialog ref={askRef} className="pcmd-dialog" onClose={() => setAsk(null)}>
        {ask && (
          <form className="pcmd-form" onSubmit={(e) => { e.preventDefault(); void start(ask.cmd, ask.values) }}>
            <h3 className="pcmd-dialog-title">{ask.cmd.title}</h3>
            <p className="pcmd-help data-mono">{ask.cmd.command}</p>
            {Object.keys(ask.values).map((n, i) => (
              <div key={n}>
                <label className="form-label" htmlFor={`pcmd-v-${n}`}>{n}</label>
                <input id={`pcmd-v-${n}`} className="form-input" value={ask.values[n]} autoFocus={i === 0}
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
