import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { admin } from "better-auth/plugins"
import { nextCookies } from "better-auth/next-js"
import { prisma } from "@/lib/prisma"

export const auth = betterAuth({
  // Reuse the SAME Prisma client the rest of the app already uses
  // (lib/prisma.ts, with the PrismaPg adapter). Better Auth does not
  // get its own connection — it shares yours.
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  // The signing secret for session tokens. Comes from the environment.
  // docker-compose.yml passes BETTER_AUTH_SECRET into the container.
  secret: process.env.BETTER_AUTH_SECRET,

  // The canonical URL the app is served from. Better Auth uses this to
  // build callback URLs and validate origins. Matches docker-compose.yml.
  baseURL: process.env.BETTER_AUTH_URL,

  emailAndPassword: {
    enabled: true,
    // Closed system: no public sign-up. Only an admin can create
    // accounts (via the admin plugin's createUser). This disables the
    // public /sign-up/email endpoint.
    disableSignUp: true,
    // Reasonable floor. NIST guidance favors length over complexity rules.
    minPasswordLength: 10,
    maxPasswordLength: 128,
    // We are NOT doing email verification in this phase (no mail server
    // on the LAN yet). Accounts created by an admin are trusted.
    requireEmailVerification: false,
  },

  // Database-backed sessions (not stateless JWT). This is what makes
  // immediate revocation possible: deleting the Session row logs the
  // user out everywhere on their next request.
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh the 7-day window once per day of activity
  },

  plugins: [
    // The admin plugin. Gives us server + client APIs for listing users,
    // creating users, setting roles, banning, impersonating, and managing
    // sessions. defaultRole/adminRole shown explicitly so the convention
    // is visible rather than implied.
    admin({
      defaultRole: "user",
      adminRole: "admin",
    }),

    // MUST be last in the plugins array. This plugin makes Better Auth set
    // cookies correctly through Next.js server actions / route handlers.
    // Order matters: it wraps the others.
    nextCookies(),
  ],
})
