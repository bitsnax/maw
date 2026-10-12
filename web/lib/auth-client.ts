"use client"

import { createAuthClient } from "better-auth/react"
import { adminClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  // No baseURL needed: the client talks to the same origin it was served
  // from (https://maw.lan.arpa), hitting /api/auth/* which the route
  // handler below serves. Better Auth defaults to same-origin.
  plugins: [
    // Mirrors the server-side admin() plugin. Without this, calls like
    // authClient.admin.listUsers() would not exist on the client.
    adminClient(),
  ],
})

// Convenience re-exports so components can do:
//   import { signIn, signOut, useSession } from "@/lib/auth-client"
export const { signIn, signOut, useSession } = authClient
