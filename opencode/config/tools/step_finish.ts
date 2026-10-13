import { tool } from "@opencode-ai/plugin"
import { call } from "../maw-lib/maw.ts"
// MAW story tool: finishes the step being carried out.
export default tool({
  description: "Finish this step: status done when every change is made, or blocked when the step cannot be done within its read budget and files (say why). MAW then runs the project's verify commands itself. Then stop; do not start another step.",
  args: {
    status: tool.schema.enum(["done", "blocked"]),
    summary: tool.schema.string().describe("files changed and anything the developer should know, or why it is blocked"),
  },
  async execute(args, ctx) {
    return call("step_finish", ctx, args)
  },
})
