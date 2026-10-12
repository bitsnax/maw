"use client"

// Keyboard shortcut registry and hook.
//
// One document-level keydown listener (attached lazily on first use)
// dispatches to a Map of registered handlers. Components call
// useShortcut(key, handler) and get automatic lifecycle handling:
// register on mount, unregister on unmount.
//
// WHY a central registry instead of a useEffect-per-component:
//   1. One document listener vs. N — measurable in big apps, principled
//      in small ones.
//   2. The forthcoming markdown-cheat-codes modal needs to ENUMERATE
//      every registered shortcut. A scattered set of useEffects has no
//      way to introspect itself. The Map is the source of truth and
//      getRegisteredShortcuts() exposes it.
//   3. Future features (scopes, priority, sequence keys like 'g p')
//      attach to the central dispatch without touching call-sites.
//
// What this module deliberately does NOT do (yet):
//   - Scopes / contexts ("only when modal X is open")
//   - Priority resolution when two handlers bind the same key
//   - Sequence keys (vim-style 'g g', 'd d')
//   - Mac/Windows modifier translation (we accept "Meta" and "Control"
//     literally; the consumer chooses)
//
// The useShortcut() signature accommodates all of those additively.
//
// KEY STRING FORMAT
//
// A key string is a "+"-joined list of modifiers and a final key code:
//   "Escape"
//   "Meta+k"           (Cmd-K on Mac)
//   "Control+k"        (Ctrl-K on Windows/Linux)
//   "Shift+?"          (typing '?' with Shift)
//   "Alt+Shift+p"
//
// Modifiers: Control | Meta | Alt | Shift. Order doesn't matter — the
// matcher normalizes both the binding and the event into a canonical
// form. The key portion is matched against KeyboardEvent.key (NOT
// event.code), case-sensitive for printable characters. "Escape",
// "Enter", "ArrowUp", etc. use the standard KeyboardEvent.key values.


// USAGE 
//import { useShortcut, getRegisteredShortcuts } from "@/lib/keyboard"
//// Register the modal's own opener somewhere global:
//useShortcut("Shift+?", () => setCheatModalOpen(true), {
//  description: "Show keyboard shortcuts"
//})
//// Inside the modal, populate the list:
//const all = getRegisteredShortcuts()
//// → [{ key: "Escape", description: "Close user menu" },
////    { key: "Shift+?", description: "Show keyboard shortcuts" }, ...]


import { useEffect } from "react"

type Handler = (e: KeyboardEvent) => void

type Binding = {
  key: string             // canonical form
  handler: Handler
  enabled: () => boolean  // queried at dispatch time
  description?: string    // for future cheat-codes modal
}

// Module-level state. Keyed by canonical key string. Value is the list
// of bindings for that key — multiple components can bind the same key
// (e.g. two modals both want Escape); we'll call them all and let
// preventDefault / stopPropagation in handlers sort it out. When we
// add priority later, this becomes an ordered list with a winner.
const bindings = new Map<string, Set<Binding>>()

let listenerAttached = false

function canonicalize(key: string): string {
  // Split, normalize modifier casing, sort modifiers alphabetically,
  // preserve the final key portion as-is (it is the visible character
  // or a named key like "Escape").
  const parts = key.split("+")
  const main = parts[parts.length - 1]
  const mods = parts.slice(0, -1).map(m => {
    const lower = m.toLowerCase()
    if (lower === "control" || lower === "ctrl") return "Control"
    if (lower === "meta" || lower === "cmd" || lower === "command") return "Meta"
    if (lower === "alt" || lower === "option") return "Alt"
    if (lower === "shift") return "Shift"
    return m
  }).sort()
  return [...mods, main].join("+")
}

function eventToKey(e: KeyboardEvent): string {
  const mods: string[] = []
  if (e.ctrlKey)  mods.push("Control")
  if (e.metaKey)  mods.push("Meta")
  if (e.altKey)   mods.push("Alt")
  if (e.shiftKey) mods.push("Shift")
  mods.sort()
  return [...mods, e.key].join("+")
}

function ensureListener() {
  if (listenerAttached || typeof document === "undefined") return
  document.addEventListener("keydown", dispatch)
  listenerAttached = true
}

function dispatch(e: KeyboardEvent) {
  // Ignore keydowns originating from text-entry surfaces. Without this,
  // typing 'k' into the search box would fire any future "k" shortcut.
  // The exception: Escape, which conventionally closes modals/menus
  // even from an input.
  const target = e.target as HTMLElement | null
  const inTextField =
    !!target && (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    )
  if (inTextField && e.key !== "Escape") return

  const key = eventToKey(e)
  const set = bindings.get(key)
  if (!set || set.size === 0) return
  for (const b of set) {
    if (!b.enabled()) continue
    b.handler(e)
  }
}

/**
 * Register a keyboard shortcut for the lifetime of the calling component.
 *
 * @param key      "Escape", "Meta+k", or an array of equivalents like
 *                 ["Meta+k", "Control+k"] for cross-platform bindings.
 * @param handler  Called with the raw KeyboardEvent. Call
 *                 e.preventDefault() yourself if you need it.
 * @param opts.enabled      Boolean gate. When false, the binding is
 *                          registered but skipped at dispatch. Defaults
 *                          to true.
 * @param opts.description  Human-readable description for the future
 *                          cheat-codes modal. Optional.
 */
export function useShortcut(
  key: string | string[],
  handler: Handler,
  opts: { enabled?: boolean; description?: string } = {}
) {
  const enabled = opts.enabled ?? true

  useEffect(() => {
    ensureListener()

    const keys = (Array.isArray(key) ? key : [key]).map(canonicalize)
    const enabledRef = { current: enabled }
    enabledRef.current = enabled

    const binding: Binding = {
      key: keys.join(","),
      handler,
      enabled: () => enabledRef.current,
      description: opts.description,
    }

    for (const k of keys) {
      let set = bindings.get(k)
      if (!set) {
        set = new Set()
        bindings.set(k, set)
      }
      set.add(binding)
    }

    return () => {
      for (const k of keys) {
        const set = bindings.get(k)
        if (!set) continue
        set.delete(binding)
        if (set.size === 0) bindings.delete(k)
      }
    }
    // Intentionally omit `handler` from deps: callers should pass a
    // stable function (defined outside render or wrapped in useCallback).
    // Including it here would re-register on every render for inline
    // handlers, which is both wasteful and would cause briefly missed
    // keydowns between unregister and re-register.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Array.isArray(key) ? key.join(",") : key, enabled])
}

/**
 * Enumerate all currently registered shortcuts. Intended for the
 * forthcoming cheat-codes modal. Returns one entry per key, even if
 * multiple components have bound that key (the modal can group as it
 * sees fit). Bindings without a description are included with
 * description=undefined so the modal can skip or show them.
 */
export function getRegisteredShortcuts(): Array<{
  key: string
  description?: string
}> {
  const out: Array<{ key: string; description?: string }> = []
  for (const [key, set] of bindings.entries()) {
    for (const b of set) {
      out.push({ key, description: b.description })
    }
  }
  return out
}
