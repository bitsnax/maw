import { headers } from "next/headers"
import { auth } from "./auth"

// The signed-in user if they are an admin, otherwise null. Used by every
// Machines page and server action (a paired machine can be fully
// controlled from MAW, so Machines are admin-only).
export async function adminSession() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session || session.user.role !== "admin") return null
  return session
}
