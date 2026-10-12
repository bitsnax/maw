import { redirect } from "next/navigation"
import { adminSession } from "@/lib/admin-session"

// Machines are admin-only: a paired machine can be fully controlled from MAW.
// The (app) layout already requires a session; this adds the role.

export default async function MachinesLayout({ children }: { children: React.ReactNode }) {
  if (!(await adminSession())) redirect("/")
  return <>{children}</>
}
