"use client"

import { useState } from "react"
import { removeProjectAction } from "../actions"
import { REMOVE_PROJECT_PHRASE } from "../phrases"

// Remove project, at the bottom of the project page. Said plainly before it
// happens: nothing on the machine is touched.

export default function ProjectSettings({ projectId, name, machineName, root }: {
  projectId: string; name: string; machineName: string; root: string
}) {
  const [asking, setAsking] = useState(false)
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    setBusy(true)
    setError(null)
    const r = await removeProjectAction(projectId, typed)
    // On success the action redirects to /projects and nothing below runs.
    setBusy(false)
    setError(r.message)
  }

  return (
    <div className="settings-card">
      {error && <div className="form-alert spaced">{error}</div>}
      <div className="settings-row">
        <div>
          <div className="settings-title">Remove project</div>
          <div className="settings-text">
            Removes {name} and its sessions from MAW. The folder <span className="data-mono">{root}</span> on {machineName} is
            not touched.
          </div>
          {asking && (
            <div className="settings-confirm">
              <label className="form-field" htmlFor="remove-project-typed">
                <span className="form-label">Type &quot;{REMOVE_PROJECT_PHRASE}&quot; to confirm</span>
                <input id="remove-project-typed" className="form-input" value={typed} autoComplete="off"
                  onChange={(e) => setTyped(e.target.value)} />
              </label>
            </div>
          )}
        </div>
        {asking ? (
          <div className="settings-actions">
            <button type="button" className="btn btn-danger" disabled={busy || typed.trim().toLowerCase() !== REMOVE_PROJECT_PHRASE} onClick={remove}>
              {busy ? "Removing…" : "Remove project"}
            </button>
            <button type="button" className="btn" onClick={() => { setAsking(false); setTyped(""); setError(null) }}>Cancel</button>
          </div>
        ) : (
          <div className="settings-actions">
            <button type="button" className="btn btn-danger" onClick={() => setAsking(true)}>Remove project</button>
          </div>
        )}
      </div>
    </div>
  )
}
