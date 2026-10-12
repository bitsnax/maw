"use client"

import Link from "next/link"
import { useActionState, useEffect, useState } from "react"
import { addProject, machineFolders, type AddProjectState, type FolderChoices } from "../actions"

// Name, machine, and the project's folder on it. Picking a machine lists the
// folders under its /opt as chips (folders already used by a project are left
// out); a path can also be typed. MAW checks the folder on the machine when
// the project is added.

const initial: AddProjectState = { status: "idle" }

export default function AddProjectForm({ machines }: { machines: { id: string; name: string; address: string }[] }) {
  const [state, action, pending] = useActionState(addProject, initial)
  const v = state.status === "error" ? state.values : { name: "", machineId: machines[0]!.id, root: "" }
  const err = state.status === "error" ? state.errors : {}

  const [machineId, setMachineId] = useState(v.machineId)
  const [root, setRoot] = useState(v.root)
  const [name, setName] = useState(v.name)
  const [nameTouched, setNameTouched] = useState(v.name !== "")
  const [loaded, setLoaded] = useState<{ machineId: string; r: FolderChoices } | null>(null)

  useEffect(() => {
    let cancelled = false
    machineFolders(machineId).then((r) => { if (!cancelled) setLoaded({ machineId, r }) })
    return () => { cancelled = true }
  }, [machineId])

  const folders = loaded?.machineId === machineId ? loaded.r : null

  function pick(folder: string) {
    setRoot(folder)
    if (!nameTouched) setName(folder.split("/").filter(Boolean).at(-1) ?? "")
  }

  return (
    <form action={action} className="form-card project-form">
      {state.status === "error" && state.message && <div className="form-alert">{state.message}</div>}

      <label className="form-field" htmlFor="f-machine">
        <span className="form-label">Machine</span>
        <select id="f-machine" name="machineId" className={`form-input${err.machineId ? " has-error" : ""}`}
          value={machineId} onChange={(e) => setMachineId(e.target.value)}>
          {machines.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.address})</option>)}
        </select>
        {err.machineId && <span className="form-error">{err.machineId}</span>}
      </label>

      <label className="form-field" htmlFor="f-root">
        <span className="form-label">Folder</span>
        <input id="f-root" name="root" value={root} onChange={(e) => setRoot(e.target.value)}
          placeholder="/opt/caw" autoComplete="off" spellCheck={false}
          className={`form-input data-mono${err.root ? " has-error" : ""}`} aria-invalid={!!err.root}
          aria-describedby={err.root ? "f-root-err" : undefined} />
        {err.root && <span id="f-root-err" className="form-error">{err.root}</span>}
      </label>
      <div className="project-folders" aria-live="polite">
        {!folders ? (
          <span className="console-note">Listing folders…</span>
        ) : !folders.ok ? (
          <span className="form-error">{folders.message}</span>
        ) : folders.folders.length === 0 ? (
          <span className="console-note">No free folders under {folders.base}.</span>
        ) : (
          folders.folders.map((f) => (
            <button key={f} type="button" className={`console-chip${f === root ? " is-active" : ""}`} onClick={() => pick(f)}>
              {f.slice(folders.base.length + 1)}
            </button>
          ))
        )}
      </div>

      <label className="form-field" htmlFor="f-name">
        <span className="form-label">Name</span>
        <input id="f-name" name="name" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true) }}
          placeholder="caw" autoComplete="off" spellCheck={false}
          className={`form-input${err.name ? " has-error" : ""}`} aria-invalid={!!err.name}
          aria-describedby={err.name ? "f-name-err" : undefined} />
        {err.name && <span id="f-name-err" className="form-error">{err.name}</span>}
      </label>

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || !root.trim() || !name.trim()}>
          {pending ? "Adding…" : "Add project"}
        </button>
        <Link href="/projects" className="btn">Cancel</Link>
      </div>
    </form>
  )
}
