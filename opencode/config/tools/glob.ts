import { tool } from "@opencode-ai/plugin"
import { call, text } from "../maw-lib/maw.ts"
// Replaces OpenCode's glob: files are listed on the project's machine through MAW.
const t = text.glob
export default tool({
  description: t.description,
  args: {
    pattern: tool.schema.string().describe(t.args.pattern),
    path: tool.schema.string().optional().describe(t.args.path),
  },
  async execute(args, ctx) {
    return call("glob", ctx, args)
  },
})
