import { tool } from "@opencode-ai/plugin"
import { call } from "../maw-lib/maw.ts"
// MAW task tool: a progress note on the step being carried out.
export default tool({
  description: "Record progress on this step right after each file edit, for example \"edited web/src/a.ts: added toolCountsByConnection\". If the session runs out of room, the next session continues from these notes.",
  args: {
    text: tool.schema.string(),
  },
  async execute(args, ctx) {
    return call("step_note", ctx, args)
  },
})
