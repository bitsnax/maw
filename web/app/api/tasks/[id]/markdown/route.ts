import { adminSession } from "@/lib/admin-session"
import { getTask, taskKey, taskMarkdown } from "@/lib/tasks"

// GET /api/tasks/<id>/markdown — the task (phases, steps, checklists,
// findings) as one markdown file for your own records. Admin only.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await adminSession())) return Response.json({ ok: false, message: "Only an admin can download tasks." }, { status: 401 })
  const { id } = await ctx.params
  const s = await getTask(id)
  if (!s) return Response.json({ ok: false, message: "This task no longer exists." }, { status: 404 })
  return new Response(taskMarkdown(s), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${s.project.slug}-task-${taskKey(s)}.md"`,
      "cache-control": "no-store",
    },
  })
}
