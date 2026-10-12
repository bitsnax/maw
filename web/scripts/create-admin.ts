/**
 * Bootstrap the first admin user.
 *
 * Why this exists and why it does NOT use auth.api.signUpEmail():
 *   lib/auth.ts sets `disableSignUp: true`. In Better Auth 1.6.11 that flag
 *   is enforced at the API layer, not just the public HTTP route — so
 *   auth.api.signUpEmail() returns EMAIL_PASSWORD_SIGN_UP_DISABLED even when
 *   called server-side. And auth.api.createUser() (admin plugin) requires an
 *   existing admin session, which we don't have yet. Classic chicken-and-egg.
 *
 *   The supported way to seed the first admin in a closed-signup system is to
 *   write the `user` + `account` rows directly via the Prisma adapter, hashing
 *   the password with Better Auth's OWN hasher (better-auth/crypto) so the
 *   login flow's verifier can read it. Hashing with bcrypt here would insert
 *   fine but fail login silently — Better Auth 1.6.11 uses scrypt, not bcrypt.
 *
 * This script is idempotent: re-running it updates the existing admin's
 * password/role instead of erroring on the unique email.
 *
 * Run from /opt/maw on the host (inside the migrate image, which has
 * the database URL and the generated Prisma client):
 *   docker compose run --rm \
 *     -e ADMIN_EMAIL="admin@maw.lan.arpa" \
 *     -e ADMIN_PASSWORD="<10+ char password>" \
 *     -e ADMIN_NAME="Admin" \
 *     migrate npx tsx scripts/create-admin.ts
 */

import { config } from "dotenv"
import { hashPassword } from "better-auth/crypto"
import { prisma } from "../lib/prisma"

// tsx does NOT auto-load .env the way `next` does. Load it explicitly so
// DATABASE_URL (and BETTER_AUTH_* for any imported config) are present.
config()

async function main() {
  const email = process.env.ADMIN_EMAIL
  const password = process.env.ADMIN_PASSWORD
  const name = process.env.ADMIN_NAME ?? "Administrator"

  if (!email || !password) {
    console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD env vars.")
    process.exit(1)
  }
  if (password.length < 10) {
    console.error("ADMIN_PASSWORD must be at least 10 characters (matches lib/auth.ts minPasswordLength).")
    process.exit(1)
  }

  // Hash with Better Auth's own function. This is the exact algorithm and
  // stored format ("salt:hash") that the credential login path verifies
  // against. Verified by round-trip test against better-auth@1.6.11.
  const passwordHash = await hashPassword(password)

  // Upsert the user row. role "admin" is the privileged value configured
  // in lib/auth.ts (adminRole: "admin"). emailVerified true because there
  // is no mail server on the LAN and admin-created accounts are trusted.
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name,
      role: "admin",
      emailVerified: true,
    },
    update: {
      name,
      role: "admin",
      emailVerified: true,
    },
  })

  // The credential account row. Better Auth's email/password provider looks
  // up the account by (providerId="credential", accountId=user's own id) and
  // reads the hash from account.password. We upsert on the user relation so
  // re-running this script rotates the password instead of duplicating rows.
  const existing = await prisma.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
  })

  if (existing) {
    await prisma.account.update({
      where: { id: existing.id },
      data: { password: passwordHash },
    })
  } else {
    await prisma.account.create({
      data: {
        // Better Auth generates ids as strings; a cuid-ish unique value is
        // fine here. crypto.randomUUID keeps it dependency-free.
        id: crypto.randomUUID(),
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: passwordHash,
      },
    })
  }

  console.log(`Admin ready: ${email} (role=admin, emailVerified=true)`)
  console.log("Sign in at https://maw.lan.arpa/login")
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
