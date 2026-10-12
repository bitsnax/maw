import { chownSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { readMachineFile } from "./machines"
import { WORKSPACES } from "./tools"

// A project's workspace: an empty folder in maw-opencode (/workspaces/<slug>,
// a volume shared with maw-web) that OpenCode treats as the project folder.
// MAW's tools translate it to the project's real folder on its machine.
// Its only file is AGENTS.md: a note saying where the project really lives,
// then the project's own AGENTS.md (read from the machine), so OpenCode
// follows the project's instructions.

/** Where the workspaces volume is mounted in this container (maw-web, or a test). */
const LOCAL_DIR = process.env.MAW_WORKSPACES_DIR || WORKSPACES

export function workspacePath(slug: string): string {
  return `${WORKSPACES}/${slug}`
}

type ProjectWithMachine = {
  name: string; slug: string; root: string
  machine: { id: string; name: string; address: string; port: number; certFingerprint: string }
}

/** The project's AGENTS.md from its machine as plain text, or null (missing or unreadable). */
async function remoteAgentsMd(p: ProjectWithMachine): Promise<string | null> {
  const lines: string[] = []
  for (let offset = 0; offset < 20_000; ) {
    const r = await readMachineFile(p.machine, p.root, "AGENTS.md", offset, 2000)
    if (!r.ok) return lines.length ? lines.join("\n") : null
    for (const l of r.data.content === "" ? [] : r.data.content.split("\n")) lines.push(l.slice(l.indexOf("| ") + 2))
    if (!r.data.more) break
    offset += r.data.lines
  }
  return lines.join("\n")
}

/** Creates or refreshes the workspace folder and its AGENTS.md. */
export async function ensureWorkspace(p: ProjectWithMachine): Promise<{ directory: string; agentsMd: boolean }> {
  const local = path.join(LOCAL_DIR, p.slug)
  mkdirSync(local, { recursive: true, mode: 0o775 })
  const own = await remoteAgentsMd(p)
  const note = [
    "# MAW workspace",
    "",
    `This session works on the project **${p.name}**, which lives on the machine **${p.machine.name}** in \`${p.root}\`.`,
    `The folder \`${workspacePath(p.slug)}\` is only a stand-in: every tool (read, write, edit, glob, grep, bash) acts on \`${p.root}\` on ${p.machine.name}.`,
    `Relative paths, paths inside \`${p.root}\`, and paths inside \`${workspacePath(p.slug)}\` all mean the same files. Commands run on ${p.machine.name}, starting in \`${p.root}\`.`,
    "",
  ]
  const text = own === null ? note.join("\n") : [...note, `---`, ``, `The project's own AGENTS.md (${p.root}/AGENTS.md):`, ``, own, ``].join("\n")
  const file = path.join(local, "AGENTS.md")
  writeFileSync(file, text, { mode: 0o664 })
  // Written by a script as root (self-tests): hand it to maw-web's user (node, 1000).
  if (process.getuid?.() === 0) { try { chownSync(local, 1000, 1000); chownSync(file, 1000, 1000) } catch { /* not ours to change */ } }
  return { directory: workspacePath(p.slug), agentsMd: own !== null }
}
