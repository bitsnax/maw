import { tool } from "@opencode-ai/plugin"
import { call } from "../maw-lib/maw.ts"
// MAW task tool: records what was found, as it is found.
export default tool({
  description: "Record a finding under this session's checklist item, right after each search or read that taught you something, even one line. Copy exact signatures, types and shapes from the source with their path and a grep pattern that finds them; do not paraphrase code. Later sessions rely on findings instead of reading the files again, and if this session runs out of room only what you recorded survives.",
  args: {
    heading: tool.schema.string().optional().describe("short title, for example the file or symbol"),
    body: tool.schema.string().describe("the finding: path, grep pattern, the exact code, and notes on how it is used"),
    item: tool.schema.number().int().min(1).optional().describe("checklist item number; defaults to this session's item"),
  },
  async execute(args, ctx) {
    return call("finding_add", ctx, args)
  },
})
