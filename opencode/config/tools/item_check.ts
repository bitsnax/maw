import { tool } from "@opencode-ai/plugin"
import { call } from "../maw-lib/maw.ts"
// MAW story tool: checks the session's checklist item, or leaves it open with a note.
export default tool({
  description: "Finish this session's checklist item. With answered true (the default) the item is checked; with answered false it stays open and your note tells the next session what is still unknown. Record the findings first with finding_add. Then stop: one item per session.",
  args: {
    answered: tool.schema.boolean().optional().describe("false to leave the item open"),
    note: tool.schema.string().optional().describe("a short answer, or what is still unknown"),
    item: tool.schema.number().int().min(1).optional().describe("checklist item number; defaults to this session's item"),
  },
  async execute(args, ctx) {
    return call("item_check", ctx, args)
  },
})
