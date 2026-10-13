"use server"

import { adminSession } from "@/lib/admin-session"
import { prisma } from "@/lib/prisma"
import { workspacePath } from "@/lib/workspace"
import {
  ocAbort, ocMessages, ocPrompt, ocQuestionReject, ocQuestionReply, ocQuestions, ocStatus,
  type OcMessage, type OcQuestion,
} from "@/lib/opencode"

// Session actions (admin only, like Projects). Pages show the message;
// nothing here throws to the browser.

type Reply<T> = { ok: true; data: T } | { ok: false; message: string }

async function sessionFor(sessionId: string) {
  if (!(await adminSession())) return { ok: false as const, message: "Only an admin can use sessions." }
  const s = await prisma.projectSession.findUnique({ where: { id: sessionId }, include: { project: { select: { id: true, slug: true } } } })
  if (!s) return { ok: false as const, message: "This session no longer exists." }
  return { ok: true as const, s, directory: workspacePath(s.project.slug) }
}

export type SessionSnapshot = { messages: OcMessage[]; busy: boolean; questions: OcQuestion[] }

/** The whole conversation, whether it is working, and open questions. */
export async function loadSession(sessionId: string): Promise<Reply<SessionSnapshot>> {
  const c = await sessionFor(sessionId)
  if (!c.ok) return c
  const [m, st, q] = await Promise.all([ocMessages(c.directory, sessionId), ocStatus(c.directory), ocQuestions(c.directory)])
  if (!m.ok) return { ok: false, message: m.message }
  const busy = st.ok ? ["busy", "retry"].includes(st.data[sessionId]?.type ?? "") : false
  return { ok: true, data: { messages: m.data, busy, questions: q.ok ? q.data.filter((x) => x.sessionID === sessionId) : [] } }
}

export async function sendPrompt(sessionId: string, text: string): Promise<Reply<null>> {
  const c = await sessionFor(sessionId)
  if (!c.ok) return c
  const t = text.trim()
  if (!t) return { ok: false, message: "Write something to send." }
  const r = await ocPrompt(c.directory, sessionId, t)
  if (!r.ok) return { ok: false, message: r.message }
  await prisma.projectSession.update({ where: { id: sessionId }, data: { updatedAt: new Date() } })
  return { ok: true, data: null }
}

export async function abortSession(sessionId: string): Promise<Reply<null>> {
  const c = await sessionFor(sessionId)
  if (!c.ok) return c
  const r = await ocAbort(c.directory, sessionId)
  return r.ok ? { ok: true, data: null } : { ok: false, message: r.message }
}

export async function answerQuestion(sessionId: string, requestId: string, answers: string[][] | null): Promise<Reply<null>> {
  const c = await sessionFor(sessionId)
  if (!c.ok) return c
  const r = answers === null ? await ocQuestionReject(c.directory, requestId) : await ocQuestionReply(c.directory, requestId, answers)
  return r.ok ? { ok: true, data: null } : { ok: false, message: r.message }
}
