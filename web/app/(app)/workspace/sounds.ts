"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toneFor, type StoryAlert, type Tone } from "@/lib/alert-tones"
import type { WsSnapshot } from "./actions"

// The Dashboard's sounds (public/sounds/*.wav): one tone when something
// reaches you, from the snapshot the toolbar polls every few seconds.
// On by default; the toolbar's toggle is remembered in this browser.
// Browsers play sound only after you have clicked on the page once.

const KEY = "maw.sound"

function readOn(): boolean {
  try { return localStorage.getItem(KEY) !== "off" } catch { return true }
}

/** Live states of your own sessions (not the runner's), by id. */
function ownSessions(s: WsSnapshot): Map<string, string> {
  const m = new Map<string, string>()
  for (const x of s.sessions) if (x.live && !x.job) m.set(x.id, x.live.state)
  for (const x of s.elsewhere) if (!x.job) m.set(x.id, x.live.state)
  return m
}

export function play(tone: Tone) {
  try { void new Audio(`/sounds/${tone}.wav`).play().catch(() => {}) } catch { /* no audio here */ }
}

export function useSounds(snap: WsSnapshot) {
  const [on, setOn] = useState(true)
  const last = useRef<{ alerts: StoryAlert[]; sessions: Map<string, string> } | null>(null)

  // The saved choice is read after the first render (no server/client mismatch).
  useEffect(() => { const t = setTimeout(() => setOn(readOn()), 0); return () => clearTimeout(t) }, [])

  useEffect(() => {
    const now = { alerts: snap.alerts, sessions: ownSessions(snap) }
    const before = last.current
    last.current = now
    if (!before || !on) return
    const tone = toneFor(before.alerts, now.alerts, { before: before.sessions, after: now.sessions })
    if (tone) play(tone)
  }, [snap, on])

  const toggle = useCallback(() => {
    setOn((v) => {
      const next = !v
      try { localStorage.setItem(KEY, next ? "on" : "off") } catch { /* only this page */ }
      if (next) play("stopped")
      return next
    })
  }, [])
  return { on, toggle }
}
