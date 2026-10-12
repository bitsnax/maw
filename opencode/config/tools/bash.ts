import { tool } from "@opencode-ai/plugin"
import { bash, text } from "../maw-lib/maw.ts"
// Replaces OpenCode's bash: the command runs on the project's machine, as its
// user, in a login shell started in the project folder (MAW's agent). Output
// is shown live; aborting the tool stops the command there.
const t = text.bash
export default tool({
  description: t.description,
  args: {
    command: tool.schema.string().describe(t.args.command),
    timeout: tool.schema.number().int().positive().optional().describe(t.args.timeout),
    workdir: tool.schema.string().optional().describe(t.args.workdir),
  },
  async execute(args, ctx) {
    await ctx.ask({ permission: "bash", patterns: [args.command], always: [], metadata: { command: args.command } })
    return bash(ctx, args, undefined)
  },
})
