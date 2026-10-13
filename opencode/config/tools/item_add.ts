import { tool } from "@opencode-ai/plugin"
import { call } from "../maw-lib/maw.ts"
// MAW task tool: adds a checklist item (a question the plan needs answered).
export default tool({
  description: "Add one item to this session's checklist (the task's, or the phase's in a phase session): one specific question the plan needs answered, such as where a function lives and its exact signature. Each item is answered in its own later session, so make each one small and concrete. Set forDeveloper when only the developer can decide (a choice between options); write the options in the text. Call it once per item, as soon as you have the question.",
  args: {
    text: tool.schema.string().describe("the question, specific enough to answer by searching the code"),
    forDeveloper: tool.schema.boolean().optional().describe("true when only the developer can answer it"),
  },
  async execute(args, ctx) {
    return call("item_add", ctx, args)
  },
})
