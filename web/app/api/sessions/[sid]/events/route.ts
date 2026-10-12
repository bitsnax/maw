import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import { workspacePath } from "@/lib/workspace"
import { sessionEventStream } from "@/lib/session-events"

// GET /api/sessions/<session id>/events — the session page's live view:
// OpenCode's events for this session as NDJSON (see lib/session-events.ts).
// Admin only, like Projects.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const fail = (status: number, message: string) =>
  Response.json({ ok: false, message }, { status, headers: { "cache-control": "no-store" } })

export async function GET(request: Request, ctx: { params: Promise<{ sid: string }> }) {
  if (!(await adminSession())) return fail(401, "Only an admin can watch sessions.")
  const { sid } = await ctx.params
  const s = await prisma.projectSession.findUnique({ where: { id: sid }, include: { project: { select: { slug: true } } } })
  if (!s) return fail(404, "This session no longer exists.")
  const r = await sessionEventStream(workspacePath(s.project.slug), s.id, request.signal)
  if (!r.ok) return fail(502, r.message)
  return new Response(r.stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  })
}
