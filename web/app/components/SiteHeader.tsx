"use client"

// WHY "use client": uses useSession() and usePathname(), and renders the
// (client) UserMenu.
//
// Sign-out semantics live inside <UserMenu>. See UserMenu.tsx and
// lib/auth.ts for the DB-session deletion flow.
//
// Styling lives in app/globals.css under "Site header", "Site navigation"
// and "User menu".

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useSession } from "@/lib/auth-client"
import UserMenu from "./UserMenu"

type NavItem = { href: string; label: string; adminOnly?: boolean }

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard" },
  { href: "/projects", label: "Projects" },
  { href: "/machines", label: "Machines", adminOnly: true },
]

export default function SiteHeader() {
  const pathname = usePathname() ?? "/"
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

  const isAdmin = session.user.role === "admin"
  const items = NAV.filter((n) => !n.adminOnly || isAdmin)
  const active = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/")

  return (
    <header className="site-header">
      <div className="site-left">
        <span className="site-brand">
          <Link className="site-home" href="/">MAW</Link>
        </span>
        <nav className="site-nav" aria-label="Main">
          {items.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`site-nav-link${active(n.href) ? " is-active" : ""}`}
              aria-current={active(n.href) ? "page" : undefined}
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </div>

      <UserMenu user={session.user} />
    </header>
  )
}
