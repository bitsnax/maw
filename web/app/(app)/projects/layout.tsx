import { redirect } from "next/navigation"
import { adminSession } from "@/lib/admin-session"

// Projects are admin-only in Phase 3, like Machines: a session works on a
// machine's files and runs commands there. The (app) layout already requires
// a session; this adds the role.

export default async function ProjectsLayout({ children }: { children: React.ReactNode }) {
  if (!(await adminSession())) redirect("/")
  return <>{children}</>
}
