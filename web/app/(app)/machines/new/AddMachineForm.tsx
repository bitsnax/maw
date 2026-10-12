"use client"

import Link from "next/link"
import { useActionState } from "react"
import { addMachine, type AddMachineState } from "../actions"
import InstallFile from "../InstallFile"

const initial: AddMachineState = { status: "idle" }

export default function AddMachineForm() {
  const [state, action, pending] = useActionState(addMachine, initial)

  if (state.status === "done") {
    return (
      <InstallFile
        view={state}
        intro={`${state.name} was added. This file is shown once: it holds the machine\u2019s private key. Copy it now. If it is lost, Reissue certificate on the machine\u2019s page makes a new one.`}
      />
    )
  }

  const v = state.status === "error" ? state.values : { name: "", address: "", port: "7017", runAs: "" }
  const err = state.status === "error" ? state.errors : {}

  return (
    <form action={action} className="form-card">
      {state.status === "error" && state.message && <div className="form-alert">{state.message}</div>}

      <Field label="Name" name="name" defaultValue={v.name} error={err.name} placeholder="caw-box" />
      <Field label="Address" name="address" defaultValue={v.address} error={err.address} placeholder="192.168.4.202" />
      <Field label="Port" name="port" defaultValue={v.port} error={err.port} inputMode="numeric" />
      <Field label="Run commands as" name="runAs" defaultValue={v.runAs} error={err.runAs} placeholder="bitsnax" />

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Adding…" : "Add machine"}
        </button>
        <Link href="/machines" className="btn">Cancel</Link>
      </div>
    </form>
  )
}

function Field(p: {
  label: string; name: string; defaultValue: string; error?: string
  placeholder?: string; inputMode?: "numeric"
}) {
  const id = `f-${p.name}`
  return (
    <label className="form-field" htmlFor={id}>
      <span className="form-label">{p.label}</span>
      <input
        id={id} name={p.name} defaultValue={p.defaultValue} placeholder={p.placeholder}
        inputMode={p.inputMode} autoComplete="off" spellCheck={false}
        className={`form-input${p.error ? " has-error" : ""}`}
        aria-invalid={!!p.error} aria-describedby={p.error ? `${id}-err` : undefined}
      />
      {p.error && <span id={`${id}-err`} className="form-error">{p.error}</span>}
    </label>
  )
}
