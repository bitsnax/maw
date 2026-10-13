"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { addProjectCommand, moveProjectCommand, removeProjectCommand, updateProjectCommand } from "./command-actions"

// Setting up a project's command buttons (your git: branch, commit, push, …).
// The buttons themselves are in the Dashboard toolbar when this project is
// picked; pressing one runs it in the project folder on its machine, with
// the output in the Dashboard's output window (never sent to the model).

export type Cmd = { id: string; title: string; command: string }

export default function ProjectCommands({ projectId, commands, root, machineName }: {
  projectId: string; commands: Cmd[]; root: string; machineName: string
}) {
  const router = useRouter()
  const [form, setForm] = useState<{ id: string | null; title: string; command: string } | null>(null)
  const [formErr, setFormErr] = useState<{ message?: string; errors?: Record<string, string> }>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formRef = useRef<HTMLDialogElement | null>(null)

  useEffect(() => { if (form) formRef.current?.showModal(); else formRef.current?.close() }, [form])

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
    setError(r.ok ? null : r.message ?? "That did not work.")
    router.refresh()
  }
  const open = (f: { id: string | null; title: string; command: string }) => { setFormErr({}); setForm(f) }

  return (
    <div className="pcmd">
      {commands.length === 0 ? (
        <p className="pcmd-note">No buttons yet. A button runs one command in <span className="data-mono">{root}</span> on {machineName}, for example <span className="data-mono">git status</span>. Buttons show in the Dashboard toolbar when this project is picked.</p>
      ) : (
        <table className="data-table pcmd-table">
          <thead><tr><th>Button</th><th>Command</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {commands.map((c, i) => (
              <tr key={c.id}>
                <td className="data-strong">{c.title}</td>
                <td className="data-mono pcmd-command">{c.command}</td>
                <td className="pcmd-actions-cell"><span className="pcmd-tools">
                  <button type="button" className="pcmd-tool" aria-label={`Move ${c.title} up`} disabled={i === 0} onClick={() => act(moveProjectCommand(c.id, -1))}>↑</button>
                  <button type="button" className="pcmd-tool" aria-label={`Move ${c.title} down`} disabled={i === commands.length - 1} onClick={() => act(moveProjectCommand(c.id, 1))}>↓</button>
                  <button type="button" className="pcmd-tool" aria-label={`Edit ${c.title}`} onClick={() => open({ id: c.id, title: c.title, command: c.command })}>Edit</button>
                  <button type="button" className="pcmd-tool is-danger" aria-label={`Remove ${c.title}`}
                    onClick={() => { if (confirm(`Remove the button "${c.title}"?`)) void act(removeProjectCommand(c.id)) }}>Remove</button>
                </span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div><button type="button" className="btn btn-small pcmd-add" onClick={() => open({ id: null, title: "", command: "" })}>Add command</button></div>
      {error && <div className="form-alert">{error}</div>}

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
              (for example <span className="data-mono">git commit -m {"{message}"}</span>); each value goes in as one word, so quotes are safe.
            </p>
            <div className="pcmd-actions">
              <button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : form.id ? "Save" : "Create"}</button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  )
}
