import { tool } from "@opencode-ai/plugin"
import { call } from "../maw-lib/maw.ts"
// MAW task tool: reads back what earlier sessions recorded for this task.
export default tool({
  description: "Read part of the task this session works on, from MAW's database: part \"task\" (the request, task plan, task checklist with findings, and the list of phases), part \"phase\" with number \"2\" (that phase's plan, checklist with findings, and its steps), or part \"step\" with number \"2.3\" (that step's full text). Use it instead of re-reading files: findings hold the exact shapes earlier sessions copied from source. Only for sessions MAW runs for a task.",
  args: {
    part: tool.schema.enum(["task", "phase", "step"]).describe("task, phase or step"),
    number: tool.schema.string().optional().describe("phase number (\"2\") or step number (\"2.3\"); not used for task"),
  },
  async execute(args, ctx) {
    return call("task_read", ctx, args)
  },
})
