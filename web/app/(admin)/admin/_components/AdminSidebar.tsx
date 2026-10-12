"use client"

// Client Component because it uses usePathname() — a React hook, which
// only works in the browser. The parent layout is a Server Component
// (see app/(admin)/layout.tsx).
//
// Styling lives in app/globals.css under "Admin sidebar".

import Link from "next/link"
import { usePathname } from "next/navigation"

type NavItem = {
  href: string
  label: string
}

const ITEMS: NavItem[] = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/users", label: "Users" },
]

export default function AdminSidebar() {
  const pathname = usePathname()

  return (
    <aside className="admin-sidebar">
      <div className="admin-sidebar-title">Admin</div>
      <nav className="admin-sidebar-nav">
        {ITEMS.map((item) => {
          // Active state rules:
          //   - /admin           → active only on exactly /admin
          //   - /admin/users     → active on /admin/users and anything
          //                        below it
          const isActive =
            item.href === "/admin"
              ? pathname === "/admin"
              : pathname === item.href || pathname.startsWith(item.href + "/")

          return (
            <Link
              key={item.href}
              href={item.href}
              className={
                "admin-sidebar-link" + (isActive ? " is-active" : "")
              }
            >
              {item.label}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
