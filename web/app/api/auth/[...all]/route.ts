import { auth } from "@/lib/auth"
import { toNextJsHandler } from "better-auth/next-js"

// Better Auth ships a helper that turns its internal handler into the
// GET/POST exports Next.js App Router route handlers expect. Every auth
// operation (sign-in, sign-out, admin.listUsers, etc.) is an HTTP call
// to /api/auth/<something>; this single catch-all serves all of them.
export const { POST, GET } = toNextJsHandler(auth)
