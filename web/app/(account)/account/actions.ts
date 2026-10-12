"use server"

import { auth } from "@/lib/auth"
import { headers } from "next/headers"
import { prisma } from "@/lib/prisma"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

// Account actions run on behalf of the SIGNED-IN USER on their own row.
// No role check — every authenticated user can edit their own profile.
// The session's userId is the authoritative target; we never accept a
// userId from the form, which would let one user edit another.

async function requireUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) throw new Error("Unauthorized")
  return session
}

// Compose the legacy `name` field from firstname + lastname. Better Auth
// reads user.name for display (UserMenu, admin list, session payload),
// so we keep it populated. Trim whitespace; if both are blank, fall back
// to null rather than an empty string so the UserMenu's
// `user.name || user.email` fallback kicks in cleanly.
function composeName(firstname: string, lastname: string): string | null {
  const composed = `${firstname} ${lastname}`.trim().replace(/\s+/g, " ")
  return composed.length > 0 ? composed : null
}

export async function updateProfile(formData: FormData) {
  const session = await requireUser()

  const firstname = String(formData.get("firstname") ?? "").trim()
  const lastname = String(formData.get("lastname") ?? "").trim()

  // Both are optional individually but we still cap length defensively
  // — firstname/lastname are TEXT columns with no DB-level limit. 100
  // chars each is plenty for any real name and prevents a 10MB POST
  // body from succeeding.
  if (firstname.length > 100 || lastname.length > 100) {
    throw new Error("Names must be 100 characters or fewer.")
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      firstname: firstname || null,
      lastname: lastname || null,
      name: composeName(firstname, lastname),
    },
  })

  // Revalidate every surface that reads user.name. UserMenu pulls it
  // from the session payload, which Better Auth re-derives on the next
  // request, so revalidating /account is enough — the layout above it
  // re-renders SiteHeader and picks up the new name.
  revalidatePath("/account")
  revalidatePath("/", "layout")

  redirect("/account")
}
