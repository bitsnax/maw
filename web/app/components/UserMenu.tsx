"use client"

// Circular avatar trigger button + dropdown menu. Replaces the
// previous .site-actions flat list of links.
//
// Close behaviors (all converge on setOpen(false)):
//   - Trigger button click again
//   - Click anywhere outside the trigger+panel subtree
//   - Escape key (via useShortcut, only while open)
//   - Clicking any menu item (Settings, Admin, Sign out)
//
// Focus management:
//   - Open via click leaves focus on the trigger (browser default for
//     button activation); we don't auto-focus the first item because
//     arrow-key navigation isn't wired yet and forced focus jumps would
//     be more disorienting than helpful for mouse-only users.
//   - On close via Escape or outside-click, we restore focus to the
//     trigger. This is the part that matters for keyboard users —
//     without it, focus is lost into the void.
//   - Menu-item clicks navigate (or sign out and redirect), so where
//     focus lands is the next page's concern, not ours.
//
// Icons:
//   - @fortawesome/react-fontawesome provides <FontAwesomeIcon>.
//   - Each icon is a named import from @fortawesome/free-solid-svg-icons.
//     Named imports are tree-shaken — only the icons actually imported
//     here ship in the bundle. Adding faPlus elsewhere doesn't bloat
//     this component; removing faGear here doesn't affect elsewhere.
//   - No library.add() / icon() calls. Those are the vanilla-JS API.
//
// Styling lives in app/globals.css under "User menu".

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { signOut } from "@/lib/auth-client"
import { useShortcut } from "@/lib/keyboard"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import {
  faGear,
  faShieldHalved,
  faArrowRightFromBracket,
} from "@fortawesome/free-solid-svg-icons"

type SessionUser = {
  name?: string | null
  email: string
  role?: string | null
}

export default function UserMenu({ user }: { user: SessionUser }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const isAdmin = user.role === "admin"
  const initial = (user.name || user.email).charAt(0).toUpperCase()
  const displayName = user.name || user.email.split("@")[0]

  // --- Outside-click closes ---------------------------------------
  // Listening on document mousedown (not click) so the menu closes
  // before the outside element's own click handler runs. Without
  // this, clicking the brand link would briefly toggle the menu
  // shut, then navigate — feels laggy on slow machines.
  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener("mousedown", onDocMouseDown)
    return () => document.removeEventListener("mousedown", onDocMouseDown)
  }, [open])

  // --- Escape closes ----------------------------------------------
  useShortcut(
    "Escape",
    () => {
      setOpen(false)
      triggerRef.current?.focus()
    },
    { enabled: open, description: "Close user menu" }
  )

  // --- Sign out ---------------------------------------------------
  // Same flow as the previous SiteHeader.tsx: signOut() deletes the
  // DB session row server-side and clears the cookie, then we navigate
  // to /login. router.refresh() is necessary so the Server Components
  // that read the session re-fetch with no session.
  async function handleSignOut() {
    setOpen(false)
    await signOut({
      fetchOptions: {
        onSuccess: () => {
          router.push("/login")
          router.refresh()
        },
      },
    })
  }

  function close() {
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="user-menu">
      <button
        ref={triggerRef}
        type="button"
        className="user-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="user-menu-panel"
        aria-label={`Account menu for ${displayName}`}
        title={displayName}
        onClick={() => setOpen(o => !o)}
      >
        {initial}
      </button>

      {open && (
        <div id="user-menu-panel" className="user-menu-panel" role="menu">
          <div className="user-menu-header">
            <div className="user-menu-name">{displayName}</div>
            <div className="user-menu-email" title={user.email}>{user.email}</div>
          </div>

          <div className="user-menu-section">
            <a
              className="user-menu-item"
              href="/account"
              role="menuitem"
              onClick={close}
            >
              <FontAwesomeIcon icon={faGear} className="user-menu-item-icon" />
              Settings
            </a>
            {isAdmin && (
              <a
                className="user-menu-item"
                href="/admin"
                role="menuitem"
                onClick={close}
              >
                <FontAwesomeIcon icon={faShieldHalved} className="user-menu-item-icon" />
                Admin
              </a>
            )}
          </div>

          <div className="user-menu-section user-menu-section-danger">
            <button
              type="button"
              className="user-menu-item user-menu-signout"
              role="menuitem"
              onClick={handleSignOut}
            >
              <FontAwesomeIcon icon={faArrowRightFromBracket} className="user-menu-item-icon" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
