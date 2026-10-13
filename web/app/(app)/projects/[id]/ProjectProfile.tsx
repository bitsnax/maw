"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { saveProjectProfile } from "../../workspace/story-actions"

// The project profile, kept in MAW: facts every story session is given
// (source roots, the decision log and schema rules, …), the verify commands
// MAW runs after each step, and the protected branches.

export default function ProjectProfile({ projectId, profile, verifyCommands, protectedBranches }: {
  projectId: string; profile: string; verifyCommands: string[]; protectedBranches: string[]
}) {
  const router = useRouter()
  const [p, setP] = useState(profile)
  const [v, setV] = useState(verifyCommands.join("\n"))
  const [b, setB] = useState(protectedBranches.join(", "))
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const dirty = p !== profile || v !== verifyCommands.join("\n") || b !== protectedBranches.join(", ")

  async function save() {
    setBusy(true)
    const r = await saveProjectProfile(projectId, { profile: p, verifyCommands: v, protectedBranches: b })
    setBusy(false)
    setNote(r.ok ? { ok: true, text: "Saved." } : { ok: false, text: r.message })
    router.refresh()
  }

  return (
    <div className="form-card pprofile">
      <label className="form-label" htmlFor="pp-verify">Verify commands (one per line, run in order after each step)</label>
      <textarea id="pp-verify" className="form-input data-mono" rows={3} value={v} spellCheck={false}
        placeholder="cd /opt/caw/web && npx tsc --noEmit" onChange={(e) => setV(e.target.value)} />
      <label className="form-label" htmlFor="pp-branches">Protected branches (never worked on)</label>
      <input id="pp-branches" className="form-input data-mono" value={b} placeholder="main, master" onChange={(e) => setB(e.target.value)} />
      <label className="form-label" htmlFor="pp-profile">Profile (given to every story session)</label>
      <textarea id="pp-profile" className="form-input data-mono" rows={10} value={p} spellCheck={false}
        placeholder="Source roots, decision log rule, schema rule, handoff location …" onChange={(e) => setP(e.target.value)} />
      {note && <div className={note.ok ? "form-alert form-alert-info" : "form-alert"}>{note.text}</div>}
      <div className="pcmd-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>Save</button>
      </div>
    </div>
  )
}
