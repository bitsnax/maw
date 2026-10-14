"use client"

import { CopyButton, highlightLines, langOf } from "@/app/components/code"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent, type Ref } from "react"
import {
  consoleList, consoleRead, consoleSearch, consoleGlob, consoleRun, consoleStatus, consoleStop, consoleJobs,
} from "../actions"
import type { DirList, SearchMatch, CommandStatus, OutputLine } from "@/lib/machines"

// Console on the machine page: try the agent's files, search and commands
// by hand. Everything happens under a project root (a folder inside /opt on
// the machine; the agent reports the base). Files are read-only here; editing is OpenCode's job.
//
//   Files   browse folders, open a file (numbered lines)
//   Search  text (regular expression) or file names; a hit opens the file
//           at that line
//   Run     a command as the machine's user, live output, Stop
//
// State that loads (a folder listing) is stored with the key it was loaded
// for; "loading" means the stored key is not the current one. That keeps
// effects free of synchronous state updates.

type Tab = "files" | "search" | "run"

type OpenFile = {
  path: string
  line: number | null
  status: "loading" | "error" | "done"
  message?: string
  lines: { n: number; text: string }[]
  totalLines: number
  more: boolean
}

export default function Console({ machineId, base: BASE, initialRoot, runAs, commandsOk, commandsError }: {
  machineId: string
  base: string // the agent's allowed base (/opt): every root is inside it
  initialRoot: string // from ?root= (kept in the page address, so a reload or a link keeps it)
  runAs: string
  commandsOk: boolean
  commandsError?: string
}) {
  const [tab, setTab] = useState<Tab>("files")
  const [root, setRoot] = useState(initialRoot)
  const [rootInput, setRootInput] = useState(initialRoot)
  const [projects, setProjects] = useState<string[]>([])
  const [dir, setDir] = useState(".")
  const [file, setFile] = useState<OpenFile | null>(null)

  // Folders under /opt, offered as roots.
  useEffect(() => {
    let cancelled = false
    consoleList(machineId, BASE, ".").then((r) => {
      if (!cancelled && r.ok) setProjects(r.data.entries.filter((e) => e.type === "dir" || e.target === "dir").map((e) => `${BASE}/${e.name}`))
    })
    return () => { cancelled = true }
  }, [machineId, BASE])

  function applyRoot(next: string) {
    const r = next.trim().replace(/\/+$/, "") || BASE
    setRootInput(r)
    setRoot(r)
    setDir(".")
    setFile(null)
    // In the address without a navigation (the page is not fetched again).
    const u = new URL(window.location.href)
    if (r === BASE) u.searchParams.delete("root")
    else u.searchParams.set("root", r)
    window.history.replaceState(null, "", u)
  }

  async function openFile(path: string, line: number | null = null) {
    const offset = line && line > 1500 ? line - 100 : 0
    setFile({ path, line, status: "loading", lines: [], totalLines: 0, more: false })
    setTab("files")
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."
    setDir(parent || ".")
    const r = await consoleRead(machineId, root, path, offset)
    setFile(r.ok
      ? { path, line, status: "done", lines: parseRead(r.data.content), totalLines: r.data.totalLines, more: r.data.more }
      : { path, line, status: "error", message: r.message, lines: [], totalLines: 0, more: false })
  }

  async function readMore() {
    if (!file || file.status !== "done") return
    const offset = file.lines.at(-1)?.n ?? 0
    const r = await consoleRead(machineId, root, file.path, offset)
    if (r.ok) setFile({ ...file, lines: [...file.lines, ...parseRead(r.data.content)], more: r.data.more })
  }

  return (
    <div className="console">
      <div className="console-root">
        <label className="form-label" htmlFor="console-root">Root</label>
        <input
          id="console-root" className="form-input data-mono" list="console-projects" value={rootInput}
          onChange={(e) => setRootInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") applyRoot(rootInput) }}
          spellCheck={false} autoComplete="off"
        />
        <datalist id="console-projects">
          {projects.map((p) => <option key={p} value={p} />)}
        </datalist>
        <button type="button" className="btn btn-small" onClick={() => applyRoot(rootInput)} disabled={rootInput.trim() === root}>Open</button>
        {projects.length > 0 && (
          <div className="console-projects">
            {projects.map((p) => (
              <button key={p} type="button" className={`console-chip${p === root ? " is-active" : ""}`} onClick={() => applyRoot(p)}>
                {p.slice(BASE.length + 1)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="console-tabs" role="tablist">
        {(["files", "search", "run"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`console-tab${tab === t ? " is-active" : ""}`} onClick={() => setTab(t)}>
            {t === "files" ? "Files" : t === "search" ? "Search" : "Run"}
          </button>
        ))}
      </div>

      <div className="console-body">
        {/* Kept mounted, so a search's results and a running command survive switching tabs. */}
        <div hidden={tab !== "files"}>
          <Files machineId={machineId} root={root} dir={dir} setDir={(d) => { setDir(d); setFile(null) }}
            file={file} openFile={openFile} closeFile={() => setFile(null)} readMore={readMore} />
        </div>
        <div hidden={tab !== "search"}>
          <Search machineId={machineId} root={root} openFile={openFile} />
        </div>
        <div hidden={tab !== "run"}>
          <Run machineId={machineId} root={root} runAs={runAs} commandsOk={commandsOk} commandsError={commandsError} />
        </div>
      </div>
    </div>
  )
}

/** "00012| text" lines from the agent's read into numbers and text. */
function parseRead(content: string): { n: number; text: string }[] {
  if (content === "") return []
  return content.split("\n").map((l) => {
    const bar = l.indexOf("| ")
    return { n: Number(l.slice(0, bar)), text: l.slice(bar + 2) }
  })
}

function size(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}

function when(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
}

// ---- Files ----------------------------------------------------------------

function Files({ machineId, root, dir, setDir, file, openFile, closeFile, readMore }: {
  machineId: string; root: string; dir: string; setDir: (d: string) => void
  file: OpenFile | null; openFile: (path: string, line?: number | null) => void; closeFile: () => void; readMore: () => void
}) {
  const key = `${root}\n${dir}`
  const [loaded, setLoaded] = useState<{ key: string; list?: DirList; message?: string } | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    consoleList(machineId, root, dir).then((r) => {
      if (!cancelled) setLoaded(r.ok ? { key, list: r.data } : { key, message: r.message })
    })
    return () => { cancelled = true }
  }, [machineId, root, dir, key, nonce])

  const loading = loaded?.key !== key
  const parts = dir === "." ? [] : dir.split("/")
  const join = (name: string) => (dir === "." ? name : `${dir}/${name}`)

  return (
    <div className="console-files">
      <div className="console-crumbs">
        <button type="button" className="data-link console-crumb" onClick={() => setDir(".")}>{root}</button>
        {parts.map((p, i) => (
          <span key={i}>
            <span className="breadcrumbs-separator">/</span>
            <button type="button" className="data-link console-crumb" onClick={() => setDir(parts.slice(0, i + 1).join("/"))}>{p}</button>
          </span>
        ))}
        <button type="button" className="btn btn-small" onClick={() => setNonce((n) => n + 1)} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {file ? (
        <FileView file={file} closeFile={closeFile} readMore={readMore} />
      ) : loading ? (
        <p className="app-empty">Loading {dir === "." ? root : dir}…</p>
      ) : loaded?.message ? (
        <div className="form-alert">{loaded.message}</div>
      ) : loaded?.list && loaded.list.entries.length === 0 ? (
        <p className="app-empty">This folder is empty.</p>
      ) : loaded?.list ? (
        <table className="data-table console-list">
          <thead><tr><th>Name</th><th>Size</th><th>Modified</th></tr></thead>
          <tbody>
            {dir !== "." && (
              <tr>
                <td colSpan={3}>
                  <button type="button" className="data-link console-entry" onClick={() => setDir(parts.slice(0, -1).join("/") || ".")}>..</button>
                </td>
              </tr>
            )}
            {loaded.list.entries.map((e) => {
              const isDir = e.type === "dir" || (e.type === "link" && e.target === "dir")
              const isFile = e.type === "file" || (e.type === "link" && e.target === "file")
              return (
                <tr key={e.name}>
                  <td>
                    {isDir || isFile ? (
                      <button type="button" className={`data-link console-entry${isDir ? " is-dir" : ""}`}
                        onClick={() => (isDir ? setDir(join(e.name)) : openFile(join(e.name)))}>
                        {e.name}{isDir ? "/" : ""}
                      </button>
                    ) : (
                      <span className="console-entry is-other">{e.name}</span>
                    )}
                    {e.type === "link" && <span className="tag">{e.target === "broken" ? "broken link" : "link"}</span>}
                  </td>
                  <td className="data-nowrap">{isDir ? "" : size(e.size)}</td>
                  <td className="data-nowrap">{when(e.modified)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}
      {loaded?.list?.truncated && !file && <p className="console-note">Only the first 5,000 entries are shown.</p>}
    </div>
  )
}

function FileView({ file, closeFile, readMore }: { file: OpenFile; closeFile: () => void; readMore: () => void }) {
  const hit = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (file.status === "done" && hit.current) hit.current.scrollIntoView({ block: "center" })
  }, [file.status, file.path, file.line])

  return (
    <div className="logs-panel">
      <div className="logs-head">
        <span className="data-mono">
          {file.path}
          {file.status === "done" && ` · ${file.totalLines} line${file.totalLines === 1 ? "" : "s"}`}
          {file.line ? ` · line ${file.line}` : ""}
        </span>
        <span className="console-file-actions">
          {file.status === "done" && file.lines.length > 0 && <CopyButton text={file.lines.map((l) => l.text).join("\n")} label="Copy file" />}
          <button type="button" className="btn btn-small" onClick={closeFile}>Close</button>
        </span>
      </div>
      {file.status === "loading" && <p className="app-empty">Opening…</p>}
      {file.status === "error" && <div className="form-alert">{file.message}</div>}
      {file.status === "done" && (
        file.lines.length === 0 ? <p className="app-empty">The file is empty.</p> : (
          <FileLines file={file} hit={hit} />
        )
      )}
      {file.status === "done" && file.more && (
        <button type="button" className="btn btn-small" onClick={readMore}>Load the next 2,000 lines</button>
      )}
    </div>
  )
}

// ---- Search ---------------------------------------------------------------

function Search({ machineId, root, openFile }: {
  machineId: string; root: string; openFile: (path: string, line?: number | null) => void
}) {
  const [mode, setMode] = useState<"text" | "names">("text")
  const [pattern, setPattern] = useState("")
  const [include, setInclude] = useState("")
  const [ignoreCase, setIgnoreCase] = useState(true)
  const [busy, setBusy] = useState(false)
  type Result =
    | { kind: "text"; root: string; pattern: string; matches: SearchMatch[]; truncated: boolean }
    | { kind: "names"; root: string; pattern: string; files: string[]; truncated: boolean }
    | { kind: "error"; message: string }
  const [result, setResult] = useState<Result | null>(null)

  async function go() {
    if (!pattern.trim()) return
    setBusy(true)
    if (mode === "text") {
      const r = await consoleSearch(machineId, root, pattern, { include: include.trim(), ignoreCase })
      setResult(r.ok ? { kind: "text", root, pattern, matches: r.data.matches, truncated: r.data.truncated } : { kind: "error", message: r.message })
    } else {
      const r = await consoleGlob(machineId, root, pattern.trim())
      setResult(r.ok ? { kind: "names", root, pattern, files: r.data.files, truncated: r.data.truncated } : { kind: "error", message: r.message })
    }
    setBusy(false)
  }
  const stale = result && result.kind !== "error" && result.root !== root

  return (
    <div className="console-search">
      <div className="console-form">
        <div className="console-modes">
          <label><input type="radio" checked={mode === "text"} onChange={() => setMode("text")} /> Text</label>
          <label><input type="radio" checked={mode === "names"} onChange={() => setMode("names")} /> File names</label>
        </div>
        <input
          className="form-input data-mono console-grow" value={pattern} spellCheck={false} autoComplete="off"
          placeholder={mode === "text" ? "Regular expression, e.g. prisma|PrismaClient" : "Pattern, e.g. *.ts or src/**/*.tsx"}
          aria-label={mode === "text" ? "Search for" : "File name pattern"}
          onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go() }}
        />
        {mode === "text" && (
          <>
            <input
              className="form-input data-mono console-include" value={include} spellCheck={false} autoComplete="off"
              placeholder="In files, e.g. *.ts" aria-label="Only in files matching"
              onChange={(e) => setInclude(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go() }}
            />
            <label className="console-check"><input type="checkbox" checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)} /> Ignore case</label>
          </>
        )}
        <button type="button" className="btn btn-primary btn-small" onClick={() => void go()} disabled={busy || !pattern.trim()}>
          {busy ? "Searching…" : "Search"}
        </button>
      </div>
      <p className="console-note">Files that .gitignore excludes (node_modules, build output, .env) are skipped.</p>

      {stale && <p className="console-note">These results are for {result.root}; search again for {root}.</p>}
      {result?.kind === "error" && <div className="form-alert">{result.message}</div>}
      {result?.kind === "text" && (
        result.matches.length === 0 ? <p className="app-empty">No matches for {result.pattern}.</p> : (
          <>
            <p className="console-note">
              {result.matches.length} match{result.matches.length === 1 ? "" : "es"}
              {result.truncated ? " (the first 500; narrow the search for more)" : ""}
            </p>
            <ul className="console-hits">
              {result.matches.map((h, i) => (
                <li key={`${h.file}:${h.line}:${i}`}>
                  <button type="button" className="console-hit" onClick={() => openFile(h.file, h.line)} disabled={!!stale}>
                    <span className="console-hit-where">{h.file}:{h.line}</span>
                    <span className="console-hit-text">{h.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      )}
      {result?.kind === "names" && (
        result.files.length === 0 ? <p className="app-empty">No files match {result.pattern}.</p> : (
          <>
            <p className="console-note">
              {result.files.length} file{result.files.length === 1 ? "" : "s"}, newest first
              {result.truncated ? " (the first 1,000)" : ""}
            </p>
            <ul className="console-hits">
              {result.files.map((f) => (
                <li key={f}>
                  <button type="button" className="console-hit" onClick={() => openFile(f)} disabled={!!stale}>
                    <span className="console-hit-where">{f}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </div>
  )
}

// ---- Run --------------------------------------------------------------------

const LIMITS = [
  { seconds: 60, label: "1 minute" },
  { seconds: 600, label: "10 minutes" },
  { seconds: 3600, label: "1 hour" },
]
const KEEP_LINES = 2000

type Job = { id: string; command: string; root: string; startedAt: number; timeoutSeconds: number }
type Outcome = { state: CommandStatus["state"]; exitCode: number | null; durationMs: number; timeoutSeconds: number; error: string | null }

function outcomeText(o: Outcome): string {
  const s = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`)
  switch (o.state) {
    case "exited": return `exit ${o.exitCode} · ${s(o.durationMs)}`
    case "stopped": return `stopped · ${s(o.durationMs)}`
    case "timed_out": return `timed out after ${o.timeoutSeconds} s`
    case "failed": return `could not start: ${o.error ?? "unknown error"}`
    default: return "running"
  }
}

function Run({ machineId, root, runAs, commandsOk, commandsError }: {
  machineId: string; root: string; runAs: string; commandsOk: boolean; commandsError?: string
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [command, setCommand] = useState("")
  const [limit, setLimit] = useState(600)
  const [job, setJob] = useState<Job | null>(null)
  const [phase, setPhase] = useState<"idle" | "starting" | "running" | "stopping" | "ended">("idle")
  const [lines, setLines] = useState<OutputLine[]>([])
  const [skipped, setSkipped] = useState(0)
  const [showLogin, setShowLogin] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [others, setOthers] = useState<CommandStatus[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const outRef = useRef<HTMLPreElement | null>(null)
  const stickRef = useRef(true)

  // Commands already running on the machine (started earlier, or elsewhere).
  useEffect(() => {
    let cancelled = false
    consoleJobs(machineId).then((r) => {
      if (!cancelled && r.ok) setOthers(r.data.jobs.filter((j) => j.state === "running"))
    })
    return () => { cancelled = true; abortRef.current?.abort() }
  }, [machineId])

  // Elapsed time while running.
  useEffect(() => {
    if (phase !== "running" && phase !== "stopping") return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [phase])

  // Follow the output unless the reader scrolled up.
  useEffect(() => {
    const el = outRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [lines])

  function finished(id: string, o: Outcome) {
    setOutcome(o)
    setPhase("ended")
    setOthers((xs) => xs.filter((x) => x.id !== id))
    startTransition(() => router.refresh()) // Recent actions
  }

  /** Reads the stream from `after`; reconnects (resuming) up to 3 times; then falls back to the status. */
  async function follow(j: Job, after: number) {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    let last = after
    let failures = 0
    while (!ac.signal.aborted) {
      let ended = false
      try {
        const res = await fetch(`/api/machines/${machineId}/exec/${j.id}?after=${last}`, { signal: ac.signal, cache: "no-store" })
        if (!res.ok) {
          const b = (await res.json().catch(() => null)) as { message?: string } | null
          throw new Error(b?.message ?? `The output could not be opened (${res.status}).`)
        }
        const reader = res.body!.getReader()
        const dec = new TextDecoder()
        let buf = ""
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const batch: OutputLine[] = []
          let nl: number
          while ((nl = buf.indexOf("\n")) >= 0) {
            const raw = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            if (!raw.trim()) continue
            const e = JSON.parse(raw) as { type: string; count?: number; message?: string } & OutputLine & CommandStatus
            if (e.type === "line") { batch.push({ seq: e.seq, t: e.t, stream: e.stream, text: e.text, login: e.login }); last = e.seq }
            else if (e.type === "skipped") setSkipped((n) => n + (e.count ?? 0))
            else if (e.type === "end") { ended = true; finished(j.id, e) }
            else if (e.type === "error") throw new Error(e.message ?? "The output stream broke off.")
          }
          if (batch.length) { failures = 0; setLines((xs) => [...xs, ...batch].slice(-KEEP_LINES)) }
        }
      } catch (e) {
        if (ac.signal.aborted) return
        failures++
        if (failures > 3) {
          const s = await consoleStatus(machineId, j.id)
          if (s.ok && s.data.state !== "running") finished(j.id, s.data)
          else setError(`${e instanceof Error ? e.message : String(e)} The command may still be running; Stop still works.`)
          return
        }
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      if (ended) return
    }
  }

  function begin(j: Job) {
    setJob(j)
    setLines([])
    setSkipped(0)
    setOutcome(null)
    setError(null)
    setShowLogin(false)
    stickRef.current = true
    setNow(Date.now())
    setPhase("running")
    void follow(j, 0)
  }

  async function run() {
    const cmd = command.trim()
    if (!cmd || phase === "starting" || phase === "running" || phase === "stopping") return
    setPhase("starting")
    setError(null)
    const r = await consoleRun(machineId, root, cmd, limit)
    if (!r.ok) {
      setPhase(job ? "ended" : "idle")
      setError(r.message)
      startTransition(() => router.refresh())
      return
    }
    begin({ id: r.data.jobId, command: cmd, root: r.data.root, startedAt: Date.parse(r.data.startedAt), timeoutSeconds: r.data.timeoutSeconds })
  }

  async function stop(id = job?.id) {
    if (!id) return
    if (id === job?.id) setPhase("stopping")
    const r = await consoleStop(machineId, id)
    if (!r.ok) {
      setError(r.message)
      if (id === job?.id) setPhase("running")
      return
    }
    setOthers((xs) => xs.filter((x) => x.id !== id))
    if (id === job?.id) finished(id, r.data) // the stream's end may arrive too; same outcome
    else startTransition(() => router.refresh())
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void run()
    }
  }

  const active = phase === "running" || phase === "stopping"
  const login = lines.filter((l) => l.login)
  const shown = showLogin ? lines : lines.filter((l) => !l.login)
  const elapsed = job ? Math.max(0, Math.round((now - job.startedAt) / 1000)) : 0
  const watching = new Set(job && active ? [job.id] : [])

  return (
    <div className="console-run">
      {!commandsOk && (
        <div className="form-alert spaced">Commands do not work on this machine: {commandsError ?? "the agent's check failed"}.</div>
      )}
      {others.filter((o) => !watching.has(o.id)).map((o) => (
        <div key={o.id} className="form-alert form-alert-info spaced console-other">
          <span>Running on this machine: <span className="data-mono">{o.command}</span> in <span className="data-mono">{o.root}</span></span>
          <span className="settings-actions">
            <button type="button" className="btn btn-small" disabled={active}
              onClick={() => begin({ id: o.id, command: o.command, root: o.root, startedAt: Date.parse(o.startedAt), timeoutSeconds: o.timeoutSeconds })}>
              Watch
            </button>
            <button type="button" className="btn btn-small btn-danger" onClick={() => void stop(o.id)}>Stop</button>
          </span>
        </div>
      ))}

      <div className="console-form">
        <textarea
          className="form-input data-mono console-grow console-command" rows={1} value={command} spellCheck={false}
          placeholder={`Runs as ${runAs} in ${root} (login shell). Enter runs, Shift+Enter adds a line.`}
          aria-label="Command" onChange={(e) => setCommand(e.target.value)} onKeyDown={onKey}
        />
        <select className="form-input console-limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Time limit">
          {LIMITS.map((l) => <option key={l.seconds} value={l.seconds}>{l.label}</option>)}
        </select>
        {active ? (
          <button type="button" className="btn btn-danger btn-small" onClick={() => void stop()} disabled={phase === "stopping"}>
            {phase === "stopping" ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-small" onClick={() => void run()} disabled={phase === "starting" || !command.trim()}>
            {phase === "starting" ? "Starting…" : "Run"}
          </button>
        )}
      </div>

      {error && <div className="form-alert spaced">{error}</div>}

      {job && (
        <div className="logs-panel">
          <div className="logs-head">
            <span className="data-mono console-ran">{job.command}</span>
            <span className={`console-status${outcome ? (outcome.state === "exited" && outcome.exitCode === 0 ? " is-ok" : outcome.state === "stopped" ? "" : " is-bad") : ""}`}>
              {outcome ? outcomeText(outcome) : phase === "stopping" ? `stopping… ${elapsed} s` : `running · ${elapsed} s`}
            </span>
          </div>
          {login.length > 0 && (
            <button type="button" className="data-link console-login-toggle" onClick={() => setShowLogin((v) => !v)}>
              {showLogin ? "Hide" : "Show"} {login.length} line{login.length === 1 ? "" : "s"} from the login shell
            </button>
          )}
          <pre
            className="logs-body console-out" ref={outRef}
            onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}
          >
            {skipped > 0 && <div className="log-time">… {skipped} earlier lines are no longer kept</div>}
            {shown.length === 0 && !outcome && <div className="log-time">No output yet.</div>}
            {shown.map((l) => (
              <div key={l.seq} className={l.login ? "log-login" : l.stream === "stderr" ? "log-err" : undefined}>{l.text || " "}</div>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}

/** The open file: numbered lines, highlighted by the file's type (YAML,
 *  TypeScript, Python, …), the line you came for marked. */
function FileLines({ file, hit }: { file: { path: string; line: number | null; lines: { n: number; text: string }[] }; hit: Ref<HTMLDivElement> }) {
  const html = useMemo(() => highlightLines(file.lines.map((l) => l.text).join("\n"), langOf(file.path)), [file.lines, file.path])
  return (
    <pre className={`logs-body console-file${html ? " hljs" : ""}`}>
      {file.lines.map((l, i) => (
        <div key={l.n} ref={l.n === file.line ? hit : undefined} className={l.n === file.line ? "is-hit" : undefined}>
          <span className="console-ln">{l.n}</span>
          {html ? <span dangerouslySetInnerHTML={{ __html: html[i] ?? "" }} /> : l.text}
        </div>
      ))}
    </pre>
  )
}
