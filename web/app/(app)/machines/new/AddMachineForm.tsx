"use client"

import Link from "next/link"
import { useActionState, useState } from "react"
import { addMachine, type AddMachineState } from "../actions"

const initial: AddMachineState = { status: "idle" }

export default function AddMachineForm() {
  const [state, action, pending] = useActionState(addMachine, initial)

  if (state.status === "done") return <InstallFile state={state} />

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

function InstallFile({ state }: { state: Extract<AddMachineState, { status: "done" }> }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(state.yaml)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="install">
      <div className="form-alert form-alert-info">
        {state.name} was added. This file is shown once: it holds the machine&apos;s private key. Copy it now.
        If it is lost, Reissue certificate on the machine&apos;s page makes a new one.
      </div>

      <ol className="install-steps">
        <li>
          On {state.name}, make the agent image available. On the machine that runs MAW it already is; for
          another machine, run this on 192.168.4.201:
          <pre className="code-line">docker save {state.image} | ssh {state.address} docker load</pre>
        </li>
        <li>
          On {state.name}, create the folder:
          <pre className="code-line">sudo mkdir -p {state.dir} && sudo chown $(id -un) {state.dir}</pre>
        </li>
        <li>
          Save the file below as <code>{state.dir}/compose.yaml</code>, then start the agent:
          <pre className="code-line">cd {state.dir} && docker compose up -d</pre>
        </li>
        <li>
          Open <Link href="/machines">Machines</Link>: {state.name} shows online.
        </li>
      </ol>

      <div className="code-head">
        <span className="data-mono">{state.dir}/compose.yaml</span>
        <button type="button" className="btn btn-primary" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre className="code-block">{state.yaml}</pre>
    </div>
  )
}
