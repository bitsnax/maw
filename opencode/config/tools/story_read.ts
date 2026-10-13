import { tool } from "@opencode-ai/plugin"
import { call } from "../maw-lib/maw.ts"
// MAW story tool: reads back what earlier sessions recorded for this story.
export default tool({
  description: "Read part of the story this session works on, from MAW's database: part \"story\" (the request, story plan, story checklist with findings, and the list of phases), part \"phase\" with number \"2\" (that phase's plan, checklist with findings, and its steps), or part \"step\" with number \"2.3\" (that step's full text). Use it instead of re-reading files: findings hold the exact shapes earlier sessions copied from source. Only for sessions MAW runs for a story.",
  args: {
    part: tool.schema.enum(["story", "phase", "step"]).describe("story, phase or step"),
    number: tool.schema.string().optional().describe("phase number (\"2\") or step number (\"2.3\"); not used for story"),
  },
  async execute(args, ctx) {
    return call("story_read", ctx, args)
  },
})
