import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import { streamMachineCommand } from "@/lib/machines"

// GET /api/machines/<machine id>/exec/<job id>?after=<line number>
//
// A running command's output as it happens, for the machine page's Console:
// NDJSON passed through from the agent (one fresh mutual-TLS connection per
// stream, fingerprint checked), one event per line:
//   {"type":"line","seq","t","stream":"stdout"|"stderr","text","login"?}
//   {"type":"skipped","count"}   older lines the agent no longer keeps
//   {"type":"ping"}              every 15 s while nothing happens
//   {"type":"end", ...status}    last line: state, exit code, duration
//   {"type":"error","message"}   the agent's stream broke off before the end
// Admin only. Reconnect with ?after=<last seq seen> to resume.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function fail(status: number, message: string) {
  return Response.json({ ok: false, message }, { status, headers: { "cache-control": "no-store" } })
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string; job: string }> }) {
  const session = await adminSession()
  if (!session) return fail(401, "Only an admin can watch commands.")
  const { id, job } = await ctx.params
  const machine = await prisma.machine.findUnique({ where: { id } })
  if (!machine) return fail(404, "This machine no longer exists.")

  const afterRaw = new URL(request.url).searchParams.get("after")
  const after = afterRaw === null ? 0 : Number(afterRaw)
  if (!Number.isInteger(after) || after < 0) return fail(400, "after must be a whole number ≥ 0.")

  const r = await streamMachineCommand(machine, job, after, request.signal)
  if (!r.ok) return fail(r.status && r.status >= 400 && r.status < 500 ? r.status : 502, r.message)
  return new Response(r.data, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  })
}
