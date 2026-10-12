import { auth } from "@/lib/auth"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import AdminUsers from "./AdminUsers"

// ===========================================================================
// THE REAL SECURITY BOUNDARY.
//
// proxy.ts is an OPTIMISTIC cookie-presence check. THIS file is the lock.
// auth.api.getSession() does a database-validated session lookup. A forged
// cookie that slipped past proxy.ts has no matching row in the `session`
// table and dies here.
// ===========================================================================

export default async function AdminUsersPage() {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session) {
    redirect("/login")
  }

  if (session.user.role !== "admin") {
    redirect("/")
  }

  return <AdminUsers adminEmail={session.user.email} />
}
