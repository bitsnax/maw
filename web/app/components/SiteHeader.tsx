"use client"

// WHY "use client": uses useSession() and renders the (client) UserMenu.
//
// Sign-out semantics live inside <UserMenu>. See UserMenu.tsx and
// lib/auth.ts for the DB-session deletion flow.
//
// Styling lives in app/globals.css under "Site header" and "User menu".

import Link from "next/link"
import { useSession } from "@/lib/auth-client"
import UserMenu from "./UserMenu"

export default function SiteHeader() {
  const { data: session, isPending } = useSession()

  if (isPending) {
    return (
      <header className="site-header">
        <span className="site-brand">MAW</span>
        <span className="site-status">…</span>
      </header>
    )
  }

  if (!session) {
    return (
      <header className="site-header">
        <span className="site-brand">MAW</span>
      </header>
    )
  }

  return (
    <header className="site-header">
      <span className="site-brand">
        <Link className="site-home" href="/">MAW</Link>
      </span>

      <UserMenu user={session.user} />
    </header>
  )
}
