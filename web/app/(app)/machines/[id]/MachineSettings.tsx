"use client"

import { useState } from "react"
import { reissueCertificate, removeMachineAction } from "../actions"
import { REMOVE_PHRASE } from "../phrases"
import InstallFile, { type InstallFileView } from "../InstallFile"

// Reissue certificate and Remove machine, at the bottom of the machine page.
// Both are said plainly before they happen.

export default function MachineSettings({ machineId, name }: { machineId: string; name: string }) {
  const [mode, setMode] = useState<"idle" | "reissue" | "remove">("idle")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<InstallFileView | null>(null)
  const [typed, setTyped] = useState("")

  async function reissue() {
    setBusy(true)
    setError(null)
    const r = await reissueCertificate(machineId)
    setBusy(false)
    if (r.ok) { setIssued(r.data); setMode("idle") } else setError(r.message)
  }

  async function remove() {
    setBusy(true)
    setError(null)
    const r = await removeMachineAction(machineId, typed)
    // On success the action redirects to /machines and nothing below runs.
    setBusy(false)
    if (!r.ok) setError(r.message)
  }

  if (issued) {
    return (
      <InstallFile
        view={issued}
        reissue
        intro={`${name} has a new certificate. Its previous install file no longer works: MAW shows ${name} offline until this file is in place. This file is shown once.`}
      />
    )
  }

  return (
    <div className="settings-card">
      {error && <div className="form-alert spaced">{error}</div>}

      <div className="settings-row">
        <div>
          <div className="settings-title">Reissue certificate</div>
          <div className="settings-text">
            Makes a new key and install file for {name}. The current install file stops working at once; {name} is
            offline in MAW until the new file is in place.
          </div>
        </div>
        {mode === "reissue" ? (
          <div className="settings-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={reissue}>
              {busy ? "Issuing…" : "Reissue certificate"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setMode("idle")}>Cancel</button>
          </div>
        ) : (
          <button type="button" className="btn" onClick={() => { setMode("reissue"); setError(null) }}>Reissue certificate</button>
        )}
      </div>

      <div className="settings-row">
        <div>
          <div className="settings-title">Remove machine</div>
          <div className="settings-text">
            Removes {name} from MAW; MAW stops accepting its agent. Recent actions are kept. The agent keeps
            running on {name} until you stop it there: <code>cd /opt/maw-agent &amp;&amp; docker compose down</code>.
          </div>
          {mode === "remove" && (
            <label className="form-field settings-confirm">
              <span className="form-label">Type &quot;{REMOVE_PHRASE}&quot; to confirm</span>
              <input
                className="form-input" value={typed} onChange={(e) => setTyped(e.target.value)}
                autoComplete="off" spellCheck={false} autoFocus
              />
            </label>
          )}
        </div>
        {mode === "remove" ? (
          <div className="settings-actions">
            <button type="button" className="btn btn-danger" disabled={busy || typed.trim().toLowerCase() !== REMOVE_PHRASE} onClick={remove}>
              {busy ? "Removing…" : "Remove machine"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => { setMode("idle"); setTyped("") }}>Cancel</button>
          </div>
        ) : (
          <button type="button" className="btn btn-danger" onClick={() => { setMode("remove"); setError(null) }}>Remove machine</button>
        )}
      </div>
    </div>
  )
}
