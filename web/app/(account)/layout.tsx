import { redirect } from "next/navigation"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"

// Account route-group layout. Server Component.
//
// Security boundary: any signed-in user can reach /account/*. We don't
// gate on role (unlike (admin)/layout.tsx) because the account section
// is for managing your own profile — admins and regular users alike.
//
// proxy.ts already redirects unauthenticated requests away from
// /account based on cookie presence, but that's the optimistic check.
// This getSession() call is the real boundary: a forged cookie passes
// proxy but fails here because no matching session row exists.
//
// Shell: a single centered column. No sidebar, no breadcrumb slot. The
// page renders its own h1. Mirrors the spirit of (auth)/layout.tsx —
// task-focused, distraction-free.

export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")

  return (
    <div className="account-shell">
      <main className="account-main">{children}</main>
    </div>
  )
}
