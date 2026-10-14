"use client"

import { useMemo, useState } from "react"
import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import diff from "highlight.js/lib/languages/diff"
import dockerfile from "highlight.js/lib/languages/dockerfile"
import ini from "highlight.js/lib/languages/ini"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

// Code as MAW shows it everywhere: syntax highlighting in CAW's colors
// (the --syn-* tokens in globals.css) and a copy button. Read-only, so
// highlight.js rather than an editor. Unknown languages are shown plain.

for (const [n, l] of Object.entries({ bash, css, diff, dockerfile, ini, javascript, json, markdown, python, sql, typescript, xml, yaml })) hljs.registerLanguage(n, l)
hljs.registerAliases(["sh", "shell", "zsh", "console"], { languageName: "bash" })
hljs.registerAliases(["ts", "tsx", "mts", "cts"], { languageName: "typescript" })
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" })
hljs.registerAliases(["yml"], { languageName: "yaml" })
hljs.registerAliases(["html", "svg"], { languageName: "xml" })
hljs.registerAliases(["toml", "env", "conf"], { languageName: "ini" })
hljs.registerAliases(["py"], { languageName: "python" })
hljs.registerAliases(["md"], { languageName: "markdown" })
hljs.registerAliases(["patch"], { languageName: "diff" })
hljs.registerAliases(["prisma"], { languageName: "typescript" })

/** The language of a file, from its name (docker-compose.yml → yaml). */
export function langOf(path: string): string {
  const base = path.split("/").pop()?.toLowerCase() ?? ""
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile"
  if (base.startsWith(".env")) return "ini"
  const ext = base.includes(".") ? base.split(".").pop()! : ""
  return hljs.getLanguage(ext) ? ext : ""
}

const MAX_HIGHLIGHT = 200_000

/** Highlighted HTML split into lines. A span that runs over a line break (a
 *  block comment, a multi-line string) is closed at the end of the line and
 *  opened again on the next, so every line stands on its own. Null when the
 *  language is unknown or the text too long: show it plain. */
export function highlightLines(text: string, lang: string): string[] | null {
  if (!lang || !hljs.getLanguage(lang) || text.length > MAX_HIGHLIGHT) return null
  let html: string
  try { html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value } catch { return null }
  const out: string[] = []
  const open: string[] = []
  let line = ""
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!part) continue
    if (part === "\n") { out.push(line + "</span>".repeat(open.length)); line = open.join(""); continue }
    if (part.startsWith("<span")) open.push(part)
    else if (part === "</span>") open.pop()
    line += part
  }
  out.push(line + "</span>".repeat(open.length))
  return out
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className={`code-copy${done ? " is-done" : ""}`} aria-label={label} title={label}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text) } catch {
          const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select()
          try { document.execCommand("copy") } catch { /* nothing more to try */ } finally { t.remove() }
        }
        setDone(true); setTimeout(() => setDone(false), 1500)
      }}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {done ? <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          : <><rect x="5" y="5" width="8.5" height="8.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10.5 3.2V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.2" fill="none" stroke="currentColor" strokeWidth="1.4" /></>}
      </svg>
      <span className="code-copy-label">{done ? "Copied" : label}</span>
    </button>
  )
}

/** One command on a line (a shell command to run), highlighted, with Copy at its end. */
export function CodeLine({ text, lang = "bash" }: { text: string; lang?: string }) {
  const html = useMemo(() => highlightLines(text, lang)?.join("\n") ?? null, [text, lang])
  return (
    <div className="code-line-box">
      {html !== null ? <pre className="code-line-text hljs"><code dangerouslySetInnerHTML={{ __html: html }} /></pre> : <pre className="code-line-text"><code>{text}</code></pre>}
      <CopyButton text={text} />
    </div>
  )
}

/** A code block: the language (when known) and Copy above, the code below. */
export function Code({ text, lang = "", title, className, wrap = false }: { text: string; lang?: string; title?: string; className?: string; wrap?: boolean }) {
  const l = lang && hljs.getLanguage(lang) ? lang : ""
  const html = useMemo(() => {
    if (!l || text.length > MAX_HIGHLIGHT) return null
    try { return hljs.highlight(text, { language: l, ignoreIllegals: true }).value } catch { return null }
  }, [text, l])
  return (
    <div className={`code${className ? ` ${className}` : ""}`}>
      <div className="code-head">
        <span className="code-lang">{title ?? (l ? hljs.getLanguage(l)!.name ?? l : "")}</span>
        <CopyButton text={text} />
      </div>
      {html !== null
        ? <pre className={`code-body hljs${wrap ? " is-wrap" : ""}`}><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
        : <pre className={`code-body${wrap ? " is-wrap" : ""}`}><code>{text}</code></pre>}
    </div>
  )
}
