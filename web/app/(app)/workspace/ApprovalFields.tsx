"use client"

import { APPROVE } from "@/lib/task-limits"

// Who approves a task's plan, and whether checks wait for the phase's end:
// the same two fields in New task / Edit task and in the task's sidebar.

export default function ApprovalFields({ idPrefix, approve, checksAtEnd, disabled, onChange }: {
  idPrefix: string; approve: string; checksAtEnd: boolean; disabled?: boolean
  onChange: (approve: string, checksAtEnd: boolean) => void
}) {
  return (
    <div className="approve-fields">
      <label className="form-label" htmlFor={`${idPrefix}-approve`}>Approvals</label>
      <select id={`${idPrefix}-approve`} className="form-input" value={approve} disabled={disabled} onChange={(e) => onChange(e.target.value, checksAtEnd)}>
        {Object.entries(APPROVE).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <label className="approve-check">
        <input type="checkbox" checked={checksAtEnd} disabled={disabled} onChange={(e) => onChange(approve, e.target.checked)} />
        Hold checks to the end of each phase
      </label>
      <p className="pcmd-help">
        {approve === "you" ? "MAW stops for your approval of the phases, and of each phase\u2019s steps." : approve === "steps"
          ? "You approve the phases. MAW then plans each phase into steps, approves them and works them without stopping."
          : "MAW approves the phases and each phase\u2019s steps itself, and stops only for checklist items marked for you, checks, and blocks."}
        {checksAtEnd ? " A step marked Check does not stop the phase: MAW goes on, and the phase\u2019s checks wait for you together at its end." : " A step marked Check stops the phase until you check it."}
      </p>
    </div>
  )
}
