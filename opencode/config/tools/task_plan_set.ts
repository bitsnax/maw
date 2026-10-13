import { tool } from "@opencode-ai/plugin"
import { call } from "../maw-lib/maw.ts"
// MAW task tool: the task plan's sections.
export default tool({
  description: "Save the task plan: overview (what the phases add up to and in what order), outOfScope, and notes for the developer (decisions taken on their behalf, risks). Give any of them; each replaces what was there.",
  args: {
    overview: tool.schema.string().optional(),
    outOfScope: tool.schema.string().optional(),
    notes: tool.schema.string().optional(),
  },
  async execute(args, ctx) {
    return call("task_plan_set", ctx, args)
  },
})
