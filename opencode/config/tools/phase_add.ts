import { tool } from "@opencode-ai/plugin"
import { call } from "../maw-lib/maw.ts"
// MAW task tool: adds the next phase of the task.
export default tool({
  description: "Add the next phase of the task (phases are numbered in the order you add them). A phase is one coherent part of the work that is planned into steps on its own later, for example \"schema and data access\" before \"pages\". Order phases so each builds on the ones before. Give a title, the goal (what is true when the phase is done) and the approach (files and shape of the change, from the findings).",
  args: {
    title: tool.schema.string(),
    goal: tool.schema.string(),
    approach: tool.schema.string().optional(),
    notes: tool.schema.string().optional(),
  },
  async execute(args, ctx) {
    return call("phase_add", ctx, args)
  },
})
