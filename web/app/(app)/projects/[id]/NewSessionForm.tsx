"use client"

import { useActionState } from "react"
import { newSession, type NewSessionState } from "../session-actions"

// Starts a session in this project and opens it. The title is optional
// (MAW names it after the project and the time).

const initial: NewSessionState = {}

export default function NewSessionForm({ projectId, disabled }: { projectId: string; disabled?: boolean }) {
  const [state, action, pending] = useActionState(newSession.bind(null, projectId), initial)
  return (
    <form action={action} className="session-new">
      <input name="title" className="form-input" placeholder="Title (optional)" maxLength={120} aria-label="Session title" />
      <button type="submit" className="btn btn-primary" disabled={pending || disabled}>
        {pending ? "Starting…" : "New session"}
      </button>
      {state.message && <div className="form-alert">{state.message}</div>}
    </form>
  )
}
