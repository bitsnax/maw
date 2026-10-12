import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import AccountForm from "./AccountForm"

// Server Component. Layout already gated on session; we re-fetch here
// to get the latest user row from Prisma. The session.user object
// reflects what Better Auth cached at sign-in; firstname/lastname were
// just added to the schema and aren't in the session payload, so we
// have to read them directly from the user row.

export default async function AccountPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  const user = await prisma.user.findUnique({
    where: { id: session!.user.id },
    select: { email: true, firstname: true, lastname: true },
  })

  if (!user) {
    // Shouldn't happen — layout would have redirected. But if a session
    // somehow outlives its user row, treat it as a logged-out state.
    throw new Error("User not found.")
  }

  return (
    <AccountForm
      email={user.email}
      initialFirstname={user.firstname ?? ""}
      initialLastname={user.lastname ?? ""}
    />
  )
}
