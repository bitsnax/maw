import { tool } from "@opencode-ai/plugin"
import { call, text } from "../maw-lib/maw.ts"
// Replaces OpenCode's edit: the change is made on the project's machine through MAW.
const t = text.edit
export default tool({
  description: t.description,
  args: {
    filePath: tool.schema.string().describe(t.args.filePath),
    oldString: tool.schema.string().describe(t.args.oldString),
    newString: tool.schema.string().describe(t.args.newString),
    replaceAll: tool.schema.boolean().optional().describe(t.args.replaceAll),
  },
  async execute(args, ctx) {
    await ctx.ask({ permission: "edit", patterns: [args.filePath], always: ["*"], metadata: { filepath: args.filePath } })
    return call("edit", ctx, args)
  },
})
