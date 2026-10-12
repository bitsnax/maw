import { tool } from "@opencode-ai/plugin"
import { call, text } from "../maw-lib/maw.ts"
// Replaces OpenCode's grep: files are searched on the project's machine through MAW.
const t = text.grep
export default tool({
  description: t.description,
  args: {
    pattern: tool.schema.string().describe(t.args.pattern),
    path: tool.schema.string().optional().describe(t.args.path),
    include: tool.schema.string().optional().describe(t.args.include),
  },
  async execute(args, ctx) {
    return call("grep", ctx, args)
  },
})
