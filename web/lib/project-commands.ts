import { prisma } from "./prisma"
import { shq } from "./shell"

// Project command buttons: commands the person runs in a project's folder on
// its machine with one click (git branch, commit, push, …). Not a "use
// server" file, so self-tests can call it; the server actions that call it
// check for an admin first (Projects are admin-only).
//
// Placeholders: `{name}` (letters, digits, underscore, starting with a
// letter) anywhere in the command. When the button is pressed MAW asks for
// each value; a story page fills {branch} and {story} for you. Each value is
// put in as one shell word (single-quoted), so spaces and quotes in a commit
// message are safe. Quotes typed around a placeholder ("{message}" or
// '{message}') are dropped, since the value is quoted already.

export const TITLE_MAX = 40
export const COMMAND_MAX = 2000
const PLACEHOLDER = /(["']?)\{([A-Za-z][A-Za-z0-9_]{0,30})\}\1/g

export type CommandInput = { title: string; command: string }

/** Readable messages per field; empty when the input is fine. */
export function checkCommandInput(i: CommandInput): Record<string, string> {
  const e: Record<string, string> = {}
  const t = i.title.trim()
  if (!t) e.title = "Give the button a title, for example New branch."
  else if (t.length > TITLE_MAX) e.title = `At most ${TITLE_MAX} characters.`
  const c = i.command.trim()
  if (!c) e.command = "Enter the command the button runs, for example git status."
  else if (c.length > COMMAND_MAX) e.command = `At most ${COMMAND_MAX} characters.`
  else if (c.includes("\0")) e.command = "The command contains a NUL character."
  return e
}

/** The placeholder names in a command, in order of first use. */
export function placeholders(command: string): string[] {
  const out: string[] = []
  for (const m of command.matchAll(PLACEHOLDER)) if (!out.includes(m[2]!)) out.push(m[2]!)
  return out
}

/** The command with every placeholder replaced by its value, single-quoted.
 *  Missing or empty values are reported, not run. */
export function fillCommand(command: string, values: Record<string, string>): { ok: true; command: string } | { ok: false; missing: string[] } {
  const missing = placeholders(command).filter((n) => !(values[n] ?? "").trim())
  if (missing.length) return { ok: false, missing }
  return { ok: true, command: command.replace(PLACEHOLDER, (_m, _q, n: string) => shq(values[n]!.trim())) }
}

export function listCommands(projectId: string) {
  return prisma.projectCommand.findMany({ where: { projectId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] })
}

export async function addCommand(projectId: string, userId: string | null, i: CommandInput) {
  const errors = checkCommandInput(i)
  if (Object.keys(errors).length) return { ok: false as const, errors }
  const last = await prisma.projectCommand.findFirst({ where: { projectId }, orderBy: { position: "desc" }, select: { position: true } })
  const row = await prisma.projectCommand.create({
    data: { projectId, title: i.title.trim(), command: i.command.trim(), position: (last?.position ?? 0) + 1, createdById: userId },
  })
  return { ok: true as const, command: row }
}

export async function updateCommand(id: string, i: CommandInput) {
  const errors = checkCommandInput(i)
  if (Object.keys(errors).length) return { ok: false as const, errors }
  const r = await prisma.projectCommand.updateMany({ where: { id }, data: { title: i.title.trim(), command: i.command.trim() } })
  return r.count ? { ok: true as const } : { ok: false as const, errors: {}, message: "This button no longer exists." }
}

export async function removeCommand(id: string) {
  const r = await prisma.projectCommand.deleteMany({ where: { id } })
  return r.count > 0
}

/** Moves a button one place left (-1) or right (+1) among its project's buttons. */
export async function moveCommand(id: string, by: -1 | 1) {
  const c = await prisma.projectCommand.findUnique({ where: { id } })
  if (!c) return false
  const all = await listCommands(c.projectId)
  const i = all.findIndex((x) => x.id === id)
  const j = i + by
  if (j < 0 || j >= all.length) return true
  const order = all.map((x) => x.id)
  ;[order[i], order[j]] = [order[j]!, order[i]!]
  await prisma.$transaction(order.map((cid, k) => prisma.projectCommand.update({ where: { id: cid }, data: { position: k + 1 } })))
  return true
}
