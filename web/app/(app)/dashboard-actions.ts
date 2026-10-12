"use server"

import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import { liveStates, type LiveState } from "@/lib/session-status"

// The Dashboard's data (admin only, like Projects): sessions working now,
// then the most recent others. The page asks again every few seconds.

export type DashSession = {
  id: string; title: string; projectId: string; projectName: string; machineName: string
  user: string | null; updatedAt: string; live: LiveState | null
}
export type DashSnapshot = { ok: true; active: DashSession[]; recent: DashSession[]; unreachable: string | null } | { ok: false; message: string }

const RECENT = 8

export async function dashboardSnapshot(): Promise<DashSnapshot> {
  if (!(await adminSession())) return { ok: false, message: "Sessions are shown to admins." }
  const { states, unreachable } = await liveStates()
  const rows = await prisma.projectSession.findMany({
    orderBy: { updatedAt: "desc" },
    include: { project: { select: { id: true, name: true, machine: { select: { name: true } } } }, user: { select: { name: true, email: true } } },
  })
  const all: DashSession[] = rows.map((s) => ({
    id: s.id, title: s.title, projectId: s.project.id, projectName: s.project.name, machineName: s.project.machine.name,
    user: s.user?.name || s.user?.email || null, updatedAt: s.updatedAt.toISOString(), live: states.get(s.id) ?? null,
  }))
  return {
    ok: true,
    active: all.filter((s) => s.live),
    recent: all.filter((s) => !s.live).slice(0, RECENT),
    unreachable,
  }
}
