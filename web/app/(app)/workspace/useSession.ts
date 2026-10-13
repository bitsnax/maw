"use client"

import { useEffect, useState } from "react"
import { loadSession } from "../projects/session-actions"
import type { OcPart, OcQuestion } from "@/lib/opencode"
import { applyDelta, sortMsgs, upsertPart, type Ev, type Msg } from "./conversation"

// One OpenCode session, live: loads the conversation once (loadSession), then
// follows /api/sessions/<id>/events (NDJSON) and applies each event:
//   message.updated / message.part.updated   insert or replace
//   message.part.delta                       append streamed text to a part
//   session.status / session.idle            working or not
//   question.asked / replied / rejected      question cards
// After a broken connection it reconnects and loads the conversation again,
// so nothing missed in between is lost. A null id means no session.

export type SessionState = {
  msgs: Msg[] | null
  busy: boolean
  busySince: number | null
  questions: OcQuestion[]
  error: string | null
  live: "connecting" | "live" | "lost"
}

const EMPTY: SessionState = { msgs: null, busy: false, busySince: null, questions: [], error: null, live: "connecting" }

export function useSession(sessionId: string | null) {
  // State belongs to one session id; another id starts from EMPTY.
  const [raw, setRaw] = useState<SessionState & { sid: string | null }>({ ...EMPTY, sid: null })
  const s: SessionState = raw.sid === sessionId ? raw : EMPTY
  const set = (f: (p: SessionState) => Partial<SessionState>) =>
    setRaw((p) => { const base = p.sid === sessionId ? p : { ...EMPTY, sid: sessionId }; return { ...base, ...f(base) } })

  useEffect(() => {
    if (!sessionId) return
    const set = (f: (p: SessionState) => Partial<SessionState>) =>
      setRaw((p) => { const base = p.sid === sessionId ? p : { ...EMPTY, sid: sessionId }; return { ...base, ...f(base) } })
    let stopped = false
    const ac = new AbortController()
    const load = async () => {
      const r = await loadSession(sessionId)
      if (stopped) return
      if (!r.ok) { set(() => ({ error: r.message, msgs: [] })); return }
      set((p) => ({
        msgs: sortMsgs(r.data.messages),
        questions: r.data.questions,
        busy: r.data.busy,
        busySince: r.data.busy ? p.busySince ?? Date.now() : null,
      }))
    }
    const apply = (e: Ev) => {
      const p = e.properties ?? {}
      switch (e.type) {
        case "message.updated": {
          const info = p.info as Msg["info"]
          set((st) => {
            const cur = st.msgs ?? []
            const i = cur.findIndex((m) => m.info.id === info.id)
            return { msgs: i < 0 ? sortMsgs([...cur, { info, parts: [] }]) : cur.map((m, k) => (k === i ? { ...m, info } : m)) }
          })
          break
        }
        case "message.part.updated": set((st) => ({ msgs: upsertPart(st.msgs ?? [], p.part as OcPart) })); break
        case "message.part.delta": set((st) => ({ msgs: applyDelta(st.msgs ?? [], p as never) })); break
        case "message.removed": set((st) => ({ msgs: (st.msgs ?? []).filter((m) => m.info.id !== p.messageID) })); break
        case "message.part.removed":
          set((st) => ({ msgs: (st.msgs ?? []).map((m) => (m.info.id === p.messageID ? { ...m, parts: m.parts.filter((x) => x.id !== p.partID) } : m)) }))
          break
        case "session.status": {
          const t = (p.status as { type?: string } | undefined)?.type
          const b = t === "busy" || t === "retry"
          set((st) => ({ busy: b, busySince: b ? st.busySince ?? Date.now() : null }))
          break
        }
        case "session.idle": set(() => ({ busy: false, busySince: null })); break
        case "session.error": {
          const err = p.error as { data?: { message?: string }; name?: string } | undefined
          if (err?.name !== "MessageAbortedError") set(() => ({ error: err?.data?.message ?? err?.name ?? "The session reported an error." }))
          break
        }
        case "question.asked": set((st) => ({ questions: [...st.questions.filter((q) => q.id !== p.id), p as unknown as OcQuestion] })); break
        case "question.replied":
        case "question.rejected": set((st) => ({ questions: st.questions.filter((q) => q.id !== p.requestID) })); break
      }
    }
    const follow = async () => {
      while (!stopped) {
        try {
          const res = await fetch(`/api/sessions/${sessionId}/events`, { signal: ac.signal, cache: "no-store" })
          if (!res.ok) {
            const b = (await res.json().catch(() => null)) as { message?: string } | null
            throw new Error(b?.message ?? `The live view could not be opened (${res.status}).`)
          }
          const reader = res.body!.getReader()
          const dec = new TextDecoder()
          let buf = ""
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            let nl: number
            while ((nl = buf.indexOf("\n")) >= 0) {
              const raw = buf.slice(0, nl)
              buf = buf.slice(nl + 1)
              if (!raw.trim()) continue
              const e = JSON.parse(raw) as Ev
              if (e.type === "ready") {
                set(() => ({ live: "live" }))
                // Subscribed: load (again) now, so nothing between the first
                // load and the subscription, or during a reconnect, is missed.
                await load()
              } else if (e.type === "error") throw new Error(e.message)
              else apply(e)
            }
          }
          throw new Error("The live view ended.")
        } catch {
          if (stopped) return
          set(() => ({ live: "lost" }))
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    }
    void load().then(() => follow())
    return () => { stopped = true; ac.abort() }
  }, [sessionId])

  return {
    ...s,
    setError: (error: string | null) => set(() => ({ error })),
    dropQuestion: (id: string) => set((st) => ({ questions: st.questions.filter((q) => q.id !== id) })),
    /** After a prompt is accepted: show Working at once (events confirm it). */
    markBusy: () => set((st) => ({ busy: true, busySince: st.busySince ?? Date.now() })),
  }
}
