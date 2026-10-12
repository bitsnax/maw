import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import PasswordForm from "./PasswordForm"

// Server Component. The (account) layout already verified there's a
// session, but we don't want to assume — getSession() here is the
// real boundary if someone ever reorganizes the route tree.

export default async function PasswordPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  // Non-null assertion is safe: layout would have redirected if null.
  return <PasswordForm email={session!.user.email} />
}
