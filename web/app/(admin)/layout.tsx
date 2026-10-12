import { redirect } from "next/navigation"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import AdminSidebar from "./admin/_components/AdminSidebar"

// Admin route-group layout. Server Component.
//
// Security boundary for everything under /admin: a database-validated
// session with role "admin". proxy.ts only checks that a cookie exists;
// a forged cookie has no session row and is stopped here. Pages below
// may check again, but a new admin page is never left unguarded.
//
// The @breadcrumb parallel-route slot (app/(admin)/@breadcrumb/) renders
// the trail for the current URL.

export default async function AdminLayout({
  children,
  breadcrumb,
}: {
  children: React.ReactNode
  breadcrumb: React.ReactNode
}) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "admin") redirect("/")

  return (
    <div className="admin-shell">
      <AdminSidebar />
      <main className="admin-main">
        {breadcrumb}
        {children}
      </main>
    </div>
  )
}
