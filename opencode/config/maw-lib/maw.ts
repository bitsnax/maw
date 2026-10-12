// What MAW's six tools share: calling MAW's tool API (/api/tools/<name>) with
// the tools token. MAW finds the project from the session's workspace folder,
// runs the call on the project's machine and answers in OpenCode's own shapes
// (see web/lib/tools.ts). Errors come back as messages; the tool throws them,
// so OpenCode shows them to the model as the tool's error.

import descriptions from "./descriptions.json" with { type: "json" }

export type Ctx = {
  sessionID: string
  directory: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void
  ask(input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }): Promise<void>
}
export type Result = { title?: string; output: string; metadata?: Record<string, unknown> }

export const text = descriptions as Record<string, { description: string; args: Record<string, string> }>

const MAW_URL = (process.env.MAW_URL || "http://maw-web:3000").replace(/\/+$/, "")
const TOKEN = process.env.MAW_TOOLS_TOKEN || ""

function post(name: string, ctx: Ctx, args: Record<string, unknown>): Promise<Response> {
  if (!TOKEN) throw new Error("MAW_TOOLS_TOKEN is not set in maw-opencode, so its tools cannot reach MAW.")
  return fetch(`${MAW_URL}/api/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ sessionID: ctx.sessionID, directory: ctx.directory, args }),
    signal: ctx.abort,
  })
}

/** read, write, edit, glob, grep: one JSON answer. */
export async function call(name: string, ctx: Ctx, args: Record<string, unknown>): Promise<Result> {
  let res: Response
  try {
    res = await post(name, ctx, args)
  } catch (e) {
    if (ctx.abort.aborted) throw e
    throw new Error(`MAW could not be reached for ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
  let body: { ok?: boolean; message?: string } & Partial<Result>
  try {
    body = await res.json()
  } catch {
    throw new Error(`MAW answered ${res.status} without a readable body for ${name}.`)
  }
  if (!body.ok) throw new Error(body.message || `MAW answered ${res.status} for ${name}.`)
  return { title: body.title, output: body.output ?? "", metadata: body.metadata }
}

/** bash: MAW streams the command's lines (NDJSON); they are shown live through ctx.metadata. */
export async function bash(ctx: Ctx, args: Record<string, unknown>, description: string | undefined): Promise<Result> {
  let res: Response
  try {
    res = await post("bash", ctx, args)
  } catch (e) {
    if (ctx.abort.aborted) throw e
    throw new Error(`MAW could not be reached for bash: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!(res.headers.get("content-type") ?? "").includes("ndjson")) {
    const body = (await res.json().catch(() => ({}))) as { message?: string }
    throw new Error(body.message || `MAW answered ${res.status} for bash.`)
  }
  const title = description || String(args.command ?? "")
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let live = ""
  let last = 0
  const show = (force = false) => {
    const now = Date.now()
    if (!force && now - last < 250) return
    last = now
    ctx.metadata({ title, metadata: { output: live.length > 30000 ? live.slice(-30000) : live, description: title } })
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!raw.trim()) continue
      const e = JSON.parse(raw) as { type: string; text?: string; message?: string } & Partial<Result>
      if (e.type === "line") { live += (live ? "\n" : "") + (e.text ?? ""); show() }
      else if (e.type === "result") {
        show(true)
        return { title, output: e.output ?? "", metadata: { ...(e.metadata ?? {}), output: e.output ?? "", description: title } }
      } else if (e.type === "error") throw new Error(e.message || "The command could not be run.")
    }
  }
  if (ctx.abort.aborted) throw new Error("The command was aborted.")
  throw new Error("The connection to MAW ended before the command did.")
}
