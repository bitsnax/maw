/**
 * maw-runner: MAW's loop that carries tasks forward one model session at
 * a time (lib/task-runner.ts). Runs as the maw-runner service (the migrate
 * image: `npx tsx scripts/runner.ts`). All state is in the database, so a
 * restart picks up where it was; a running session keeps running in
 * maw-opencode and is watched again.
 *   --once   one turn, then exit (self-tests)
 * Environment: DATABASE_URL, MAW_OPENCODE_URL, MAW_OPENCODE_PASSWORD,
 * MAW_ENCRYPTION_KEY (machines), MAW_WORKSPACES_DIR.
 */

import { prisma } from "../lib/prisma"
import { runnerTick } from "../lib/task-runner"

const log = (line: string) => console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${line}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let stopping = false

async function main() {
  if (process.argv.includes("--once")) { await runnerTick(log); await prisma.$disconnect(); return }
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stopping = true; log(`${sig}: stopping after this turn`) })
  log("maw-runner started")
  let errors = 0
  while (!stopping) {
    let wait = 5000
    try {
      const r = await runnerTick(log)
      errors = 0
      wait = r === "started" ? 2000 : r === "busy" ? 3000 : 5000
    } catch (e) {
      errors++
      log(`error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      wait = Math.min(60_000, 5000 * errors)
    }
    for (let t = 0; t < wait && !stopping; t += 500) await sleep(500)
  }
  await prisma.$disconnect()
  log("maw-runner stopped")
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
