"use client"

// Password change form. Uses authClient.changePassword (Better Auth
// 1.6.11) so we go through the supported path: current password
// verification + scrypt rehash + optional session revocation. Doing
// this with raw Prisma + hashPassword() would write a valid hash but
// skip the current-password check, which would let a hijacked session
// silently rotate the credential — exactly what we don't want.
//
// On success we revoke other sessions (revokeOtherSessions: true).
// This matches the promise made on /account ("Changing your password
// signs out other sessions"). The user's current session survives
// because revocation excludes the calling session.

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { authClient } from "@/lib/auth-client"

// Mirrors lib/auth.ts emailAndPassword.minPasswordLength. If you ever
// change one, change both — Better Auth will reject server-side either
// way, but matching the floor here gives the user immediate feedback.
const MIN_PASSWORD = 10

export default function PasswordForm({ email }: { email: string }) {
  const router = useRouter()
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  function handleClose() {
    if (window.history.length > 1) {
      router.back()
    } else {
      router.push("/account")
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(false)

    // Client-side validation. These rules duplicate server checks
    // (Better Auth enforces minPasswordLength, and a wrong current
    // password is caught server-side too). The duplication is for
    // UX — no round trip needed to tell the user "passwords don't
    // match." Server is still the authority.
    if (newPassword.length < MIN_PASSWORD) {
      setError(`New password must be at least ${MIN_PASSWORD} characters.`)
      return
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation don't match.")
      return
    }
    if (newPassword === currentPassword) {
      setError("New password must differ from the current password.")
      return
    }

    setSubmitting(true)
    const { error: e2 } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: false,
    })
    setSubmitting(false)

    if (e2) {
      // Better Auth's typical messages for this endpoint:
      //   INVALID_PASSWORD            (current password wrong)
      //   PASSWORD_TOO_SHORT          (caught client-side first; backstop)
      //   PASSWORD_COMPROMISED        (only if HIBP plugin is enabled — it isn't here)
      // Surface the message verbatim; fall back to a generic line.
      setError(e2.message ?? "Failed to change password.")
      return
    }

    // Success: clear all three fields and show a confirmation. We
    // intentionally don't redirect — the user is on a settings sub-
    // page, "you changed your password" is the meaningful end state,
    // and bouncing them back to /account would hide that feedback.
    setCurrentPassword("")
    setNewPassword("")
    setConfirmPassword("")
    setSuccess(true)
  }

  return (
    <>
      <h1 className="mb-1 text-2xl font-bold">Change password</h1>
      <p className="mb-6 text-sm text-gray-600">
        Signed in as <strong>{email}</strong>
      </p>

      {error && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">
          Password changed.
        </div>
      )}

      <form onSubmit={onSubmit} className="grid gap-4">
        <label className="grid gap-1">
          <span className="text-sm font-semibold">Current password</span>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            autoComplete="current-password"
            className="rounded border border-gray-300 p-2"
          />
        </label>

        <label className="grid gap-1">
          <span className="text-sm font-semibold">New password</span>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            className="rounded border border-gray-300 p-2"
          />
          <span className="text-xs text-gray-500">
            At least {MIN_PASSWORD} characters.
          </span>
        </label>

        <label className="grid gap-1">
          <span className="text-sm font-semibold">Confirm new password</span>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            className="rounded border border-gray-300 p-2"
          />
        </label>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={
              submitting ||
              !currentPassword ||
              !newPassword ||
              !confirmPassword
            }
            className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
          >
            {submitting ? "Changing..." : "Change password"}
          </button>
          <Link
            href="/account"
            className="text-sm text-gray-700 hover:underline"
          >
            ← Back to account
          </Link>
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="ml-auto rounded border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </form>
    </>
  )
}
