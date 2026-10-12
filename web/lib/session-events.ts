import { ocEvents } from "./opencode"

// One session's live events for the browser: OpenCode's event stream for the
// project's workspace (server-sent events), filtered to that session and passed
// on as NDJSON, one event per line ({"type": "...", "properties": {...}}).
// Server-wide events without a session (plugins, catalog) are left out.
// {"type":"ping"} every 15 s keeps proxies from closing a quiet stream; a
// last {"type":"error","message"} says when OpenCode's stream broke off.

const PASS = new Set([
  "message.updated", "message.removed", "message.part.updated", "message.part.delta", "message.part.removed",
  "session.status", "session.idle", "session.error", "session.updated", "session.compacted",
  "permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected",
  "todo.updated",
])

export async function sessionEventStream(directory: string, sessionID: string, signal: AbortSignal):
  Promise<{ ok: true; stream: ReadableStream<Uint8Array> } | { ok: false; message: string }> {
  const upstream = new AbortController()
  signal.addEventListener("abort", () => upstream.abort(), { once: true })
  const r = await ocEvents(directory, upstream.signal)
  if (!r.ok) return { ok: false, message: r.message }
  const enc = new TextEncoder()
  let ping: NodeJS.Timeout | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const emit = (o: unknown) => { if (open) { try { controller.enqueue(enc.encode(JSON.stringify(o) + "\n")) } catch { open = false } } }
      emit({ type: "ready" })
      ping = setInterval(() => emit({ type: "ping" }), 15_000)
      const reader = r.data.body!.getReader()
      const dec = new TextDecoder()
      let buf = ""
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trimEnd()
            buf = buf.slice(nl + 1)
            if (!line.startsWith("data:")) continue
            let e: { type?: string; properties?: { sessionID?: string; info?: { id?: string } } }
            try { e = JSON.parse(line.slice(5).trim()) } catch { continue }
            if (!e.type || !PASS.has(e.type)) continue
            const sid = e.properties?.sessionID ?? (e.type === "session.updated" ? e.properties?.info?.id : undefined)
            if (sid !== sessionID) continue
            emit({ type: e.type, properties: e.properties })
          }
        }
        if (!signal.aborted) emit({ type: "error", message: "OpenCode's event stream ended." })
      } catch (e) {
        if (!signal.aborted) emit({ type: "error", message: `OpenCode's event stream broke off: ${e instanceof Error ? e.message : String(e)}` })
      } finally {
        if (ping) clearInterval(ping)
        open = false
        try { controller.close() } catch { /* closed */ }
      }
    },
    cancel() {
      if (ping) clearInterval(ping)
      upstream.abort()
    },
  })
  return { ok: true, stream }
}
