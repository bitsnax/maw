// Limits of the runner that the Dashboard shows too (no database here, so the
// browser may import it).

/** Sessions MAW runs on its own to repair a step whose verify or deploy failed, before it is blocked. */
export const REPAIRS = 2

/** Who approves a task's plan: you, or MAW (a setting per task). */
export const APPROVE: Record<string, string> = {
  you: "You approve phases and steps",
  steps: "You approve phases; MAW approves steps",
  all: "MAW approves phases and steps",
}
