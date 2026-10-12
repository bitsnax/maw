import { handleToolRequest } from "@/lib/tools"

// POST /api/tools/<read|write|edit|glob|grep|bash>
// Called by maw-opencode's tools only, with the tools token (not a sign-in
// cookie; proxy.ts lets /api/tools through). See lib/tools.ts.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request, ctx: { params: Promise<{ tool: string }> }) {
  const { tool } = await ctx.params
  return handleToolRequest(tool, request)
}
