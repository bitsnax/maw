import { adminSession } from "@/lib/admin-session"
import { getStory, storyKey, storyMarkdown } from "@/lib/stories"

// GET /api/stories/<id>/markdown — the story (phases, steps, checklists,
// findings) as one markdown file for your own records. Admin only.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await adminSession())) return Response.json({ ok: false, message: "Only an admin can download stories." }, { status: 401 })
  const { id } = await ctx.params
  const s = await getStory(id)
  if (!s) return Response.json({ ok: false, message: "This story no longer exists." }, { status: 404 })
  return new Response(storyMarkdown(s), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${s.project.slug}-story-${storyKey(s)}.md"`,
      "cache-control": "no-store",
    },
  })
}
