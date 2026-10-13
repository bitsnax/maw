import { tool } from "@opencode-ai/plugin"
import { call } from "../maw-lib/maw.ts"
// MAW story tool: adds the next step of this phase.
export default tool({
  description: "Add the next step of this phase. One step is one coherent change (at most 3 files, roughly 150 changed lines) that a fresh session can carry out having read nothing but the step: inline the exact signatures and rules it needs (context), anchor every change with a grep pattern, never a line number (changes), list the only reads allowed (readBudget), and the checks (verification). Order steps so types and schema come before their users. Set needsCheck when the developer must look at the running app before later steps build on it, and say in manualCheck exactly what to open and what to see (MAW deploys the project before asking, so do not tell the developer to rebuild). Set needsDeploy when later steps need this step's result running (a schema change, a new route or service); MAW also deploys before every check and when the phase ends.",
  args: {
    title: tool.schema.string(),
    files: tool.schema.string().describe("the files it changes, comma-separated"),
    goal: tool.schema.string(),
    readBudget: tool.schema.string().describe("the only reads allowed, as grep commands with a line window"),
    context: tool.schema.string().describe("exact signatures, types and rules the step needs, copied from the findings"),
    changes: tool.schema.string().describe("numbered changes, each with its file and grep anchor"),
    verification: tool.schema.string().optional().describe("extra checks besides the project's verify commands"),
    manualCheck: tool.schema.string().optional(),
    needsCheck: tool.schema.boolean().optional(),
    needsDeploy: tool.schema.boolean().optional().describe("MAW runs the project's deploy command after this step"),
  },
  async execute(args, ctx) {
    return call("step_add", ctx, args)
  },
})
