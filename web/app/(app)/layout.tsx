import { redirect } from "next/navigation"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"

// Signed-in application shell. Server Component.
//
// Every MAW screen (dashboard, projects, OpenCode sessions) lives in
// this route group. getSession() is the real security boundary;
// proxy.ts only bounces visitors with no session cookie.

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")

  return (
    <div className="app-shell">
      <main className="app-main">{children}</main>
    </div>
  )
}
