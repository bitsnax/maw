import { tool } from "@opencode-ai/plugin"
import { call } from "../maw-lib/maw.ts"
// MAW task tool: this phase's plan sections.
export default tool({
  description: "Update this phase's plan: goal, approach (files to touch and the shape of the change), notes for the developer. Give any of them; each replaces what was there.",
  args: {
    goal: tool.schema.string().optional(),
    approach: tool.schema.string().optional(),
    notes: tool.schema.string().optional(),
  },
  async execute(args, ctx) {
    return call("phase_plan_set", ctx, args)
  },
})
