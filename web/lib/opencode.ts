// MAW's client for maw-opencode (`opencode serve`, basic auth, maw-net only).
// Every call names the session's workspace folder (x-opencode-directory):
// one OpenCode server serves every project. Never throws to a page: calls
// return { ok, ... } like agent calls do.

export const OPENCODE_URL = (process.env.MAW_OPENCODE_URL || "http://maw-opencode:4096").replace(/\/+$/, "")

export type OcResult<T> = { ok: true; data: T } | { ok: false; status?: number; message: string }

export type OcSession = { id: string; title: string; directory: string; time: { created: number; updated: number } }
export type OcPart = {
  id: string; sessionID: string; messageID: string; type: string
  text?: string; tool?: string; callID?: string
  state?: { status: string; input?: Record<string, unknown>; output?: string; error?: string; title?: string; metadata?: Record<string, unknown> }
}
export type OcMessage = { info: { id: string; role: "user" | "assistant"; sessionID: string; time: { created: number; completed?: number }; error?: unknown }; parts: OcPart[] }

function headers(directory?: string): Record<string, string> {
  const pw = process.env.MAW_OPENCODE_PASSWORD ?? ""
  const h: Record<string, string> = { authorization: "Basic " + Buffer.from(`opencode:${pw}`).toString("base64"), "content-type": "application/json" }
  if (directory) h["x-opencode-directory"] = encodeURIComponent(directory)
  return h
}

export async function oc<T>(method: string, path: string, opts: { directory?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<OcResult<T>> {
  if (!process.env.MAW_OPENCODE_PASSWORD) return { ok: false, message: "MAW_OPENCODE_PASSWORD is not set in MAW's .env." }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000)
  opts.signal?.addEventListener("abort", () => ac.abort(), { once: true })
  try {
    const res = await fetch(OPENCODE_URL + path, {
      method, headers: headers(opts.directory), signal: ac.signal,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    const text = await res.text()
    let data: unknown = null
    try { data = text.trim() ? JSON.parse(text) : null } catch { data = text }
    if (!res.ok) {
      const msg = (data && typeof data === "object" && "message" in data && typeof (data as { message: unknown }).message === "string")
        ? (data as { message: string }).message
        : res.status === 401 ? "OpenCode refused MAW's password (MAW_OPENCODE_PASSWORD differs between maw-web and maw-opencode)."
        : `OpenCode answered ${res.status}.`
      return { ok: false, status: res.status, message: msg }
    }
    return { ok: true, data: data as T }
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code
    return { ok: false, message: ac.signal.aborted ? `OpenCode did not answer within ${Math.round((opts.timeoutMs ?? 15_000) / 1000)} s.`
      : code === "ECONNREFUSED" || code === "ENOTFOUND" ? `OpenCode is not reachable at ${OPENCODE_URL} (is maw-opencode running?).`
      : `OpenCode: ${e instanceof Error ? e.message : String(e)}` }
  } finally {
    clearTimeout(timer)
  }
}

export const ocHealth = () => oc<{ healthy: boolean; version: string }>("GET", "/global/health", { timeoutMs: 5000 })
// The first call for a new folder can take a while: OpenCode sets up the
// folder's instance (and, once after a fresh start, installs its plugins).
export const ocCreateSession = (directory: string, title: string) => oc<OcSession>("POST", "/session", { directory, body: { title }, timeoutMs: 120_000 })
export const ocDeleteSession = (directory: string, id: string) => oc<boolean>("DELETE", `/session/${encodeURIComponent(id)}`, { directory })
export const ocMessages = (directory: string, id: string) => oc<OcMessage[]>("GET", `/session/${encodeURIComponent(id)}/message`, { directory, timeoutMs: 30_000 })
export const ocStatus = (directory: string) => oc<Record<string, { type: string }>>("GET", "/session/status", { directory })
export const ocAbort = (directory: string, id: string) => oc<boolean>("POST", `/session/${encodeURIComponent(id)}/abort`, { directory })
/** Sends a prompt and returns at once (204); the answer arrives as events and messages. */
export const ocPrompt = (directory: string, id: string, text: string) =>
  oc<null>("POST", `/session/${encodeURIComponent(id)}/prompt_async`, { directory, body: { parts: [{ type: "text", text }] } })
