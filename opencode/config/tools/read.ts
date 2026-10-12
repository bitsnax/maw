import { tool } from "@opencode-ai/plugin"
import { call, text } from "../maw-lib/maw.ts"
// Replaces OpenCode's read: the file is read on the project's machine through MAW.
const t = text.read
export default tool({
  description: t.description,
  args: {
    filePath: tool.schema.string().describe(t.args.filePath),
    offset: tool.schema.number().int().min(0).optional().describe(t.args.offset),
    limit: tool.schema.number().int().min(0).optional().describe(t.args.limit),
  },
  async execute(args, ctx) {
    return call("read", ctx, args)
  },
})
