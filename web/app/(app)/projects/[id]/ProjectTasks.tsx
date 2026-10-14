"use client"

import Link from "next/link"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { deleteTask, editTask, newTask } from "../../workspace/task-actions"
import ApprovalFields from "../../workspace/ApprovalFields"

// The project's tasks: write one here (title, request, optional branch);
// MAW's agent breaks it into phases and steps, and it is followed on the
// Dashboard. Edit and Remove are here too.

export type TaskRow = {
  id: string; number: number; title: string; request: string; branch: string | null; approve: string; checksAtEnd: boolean
  status: string; statusLabel: string; phases: number; steps: string; updated: string
}
type Form = { id: string | null; title: string; request: string; branch: string; branchTouched: boolean; approve: string; checksAtEnd: boolean }

/** The branch a task gets unless you change it: "task-tool-count-per-connection". */
const branchFor = (title: string) => {
  const k = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "")
  return k ? `task-${k}` : ""
}

export default function ProjectTasks({ projectId, tasks }: { projectId: string; tasks: TaskRow[] }) {
  const router = useRouter()
  const ref = useRef<HTMLDialogElement | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [err, setErr] = useState<{ message?: string; errors?: Record<string, string> }>({})
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => { if (form) ref.current?.showModal(); else ref.current?.close() }, [form])
  const open = (f: Form) => { setErr({}); setForm(f) }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!form) return
    setBusy(true)
    const input = { title: form.title, request: form.request, branch: form.branch, approve: form.approve, checksAtEnd: form.checksAtEnd }
    const r = form.id ? await editTask(form.id, input) : await newTask(projectId, input)
    setBusy(false)
    if (!r.ok) { setErr({ message: r.message, errors: r.errors }); return }
    setForm(null)
    router.refresh()
  }
  async function remove(s: TaskRow) {
    if (!confirm(`Remove task ${s.number} "${s.title}" with its phases, steps and checklists? Nothing in the project folder is touched.`)) return
    const r = await deleteTask(s.id)
    setNote(r.ok ? null : r.message)
    router.refresh()
  }

  return (
    <div className="ptasks">
      {tasks.length === 0 ? (
        <p className="pcmd-note">No tasks yet. A task is work too big for one model session: MAW&apos;s agent breaks it into phases, each phase into steps, and works them one session at a time. Follow it on the Dashboard.</p>
      ) : (
        <table className="data-table">
          <thead><tr><th>Task</th><th>Status</th><th>Phases</th><th>Steps done</th><th>Updated</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {tasks.map((s) => (
              <tr key={s.id}>
                <td><Link href={`/?project=${projectId}&task=${s.id}`} className="data-link">{s.title}</Link>{s.branch && <span className="data-mono dash-muted"> {s.branch}</span>}</td>
                <td><span className={`task-status is-${s.status}`}>{s.statusLabel}</span></td>
                <td>{s.phases || "—"}</td>
                <td className="data-nowrap">{s.steps}</td>
                <td className="data-nowrap">{s.updated}</td>
                <td className="pcmd-actions-cell"><span className="pcmd-tools">
                  <button type="button" className="pcmd-tool" aria-label={`Edit task ${s.number}`}
                    onClick={() => open({ id: s.id, title: s.title, request: s.request, branch: s.branch ?? branchFor(s.title), branchTouched: !!s.branch, approve: s.approve, checksAtEnd: s.checksAtEnd })}>Edit</button>
                  <button type="button" className="pcmd-tool is-danger" aria-label={`Remove task ${s.number}`} onClick={() => void remove(s)}>Remove</button>
                </span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div><button type="button" className="btn btn-small btn-primary" onClick={() => open({ id: null, title: "", request: "", branch: "", branchTouched: false, approve: "you", checksAtEnd: false })}>New task</button></div>
      {note && <div className="form-alert">{note}</div>}

      <dialog ref={ref} className="pcmd-dialog ptask-dialog" onClose={() => setForm(null)}>
        {form && (
          <form className="pcmd-form" onSubmit={save}>
            <h3 className="pcmd-dialog-title">{form.id ? "Edit task" : "New task"}</h3>
            {err.message && !err.errors && <div className="form-alert">{err.message}</div>}
            <label className="form-label" htmlFor="st-title">Title</label>
            <input id="st-title" className="form-input" value={form.title} maxLength={120} autoFocus placeholder="Tool count per connection"
              onChange={(e) => { setForm({ ...form, title: e.target.value, branch: form.branchTouched ? form.branch : branchFor(e.target.value) }); setErr({}) }} />
            {err.errors?.title && <div className="form-error">{err.errors.title}</div>}
            <label className="form-label" htmlFor="st-request">Request</label>
            <textarea id="st-request" className="form-input" rows={10} value={form.request}
              placeholder="What to build or change, what is out of scope, and when it is done."
              onChange={(e) => { setForm({ ...form, request: e.target.value }); setErr({}) }} />
            {err.errors?.request && <div className="form-error">{err.errors.request}</div>}
            <label className="form-label" htmlFor="st-branch">Branch</label>
            <input id="st-branch" className="form-input data-mono" value={form.branch} placeholder="task-tool-count"
              onChange={(e) => { setForm({ ...form, branch: e.target.value, branchTouched: true }); setErr({}) }} />
            {err.errors?.branch && <div className="form-error">{err.errors.branch}</div>}
            <ApprovalFields idPrefix="st" approve={form.approve} checksAtEnd={form.checksAtEnd}
              onChange={(approve, checksAtEnd) => { setForm({ ...form, approve, checksAtEnd }); setErr({}) }} />
            {err.errors?.approve && <div className="form-error">{err.errors.approve}</div>}
            <p className="pcmd-help">The request is the whole brief. MAW&apos;s agent plans the task into phases, each phase into steps, and works the steps, each in its own session. MAW changes files only on this branch: before the steps run, create it with your command button (it fills your buttons&apos; {"{branch}"}). Planning reads the project and works on any branch.</p>
            <div className="pcmd-actions">
              <button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : form.id ? "Save" : "Create"}</button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  )
}
