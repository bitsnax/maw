import { tool } from "@opencode-ai/plugin"
import { call, text } from "../maw-lib/maw.ts"
// Replaces OpenCode's write: the file is written on the project's machine through MAW.
const t = text.write
export default tool({
  description: t.description,
  args: {
    content: tool.schema.string().describe(t.args.content),
    filePath: tool.schema.string().describe(t.args.filePath),
  },
  async execute(args, ctx) {
    await ctx.ask({ permission: "edit", patterns: [args.filePath], always: ["*"], metadata: { filepath: args.filePath } })
    return call("write", ctx, args)
  },
})
