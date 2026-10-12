"use client"

// Profile form. Client Component because it owns input state and
// submit-button loading state. The actual write is a Server Action
// (updateProfile in ./actions); this file only collects values.
//
// Save = submit the form (Server Action runs, redirects back here).
// Cancel = reset the inputs to the original values passed in via
//   props. We do NOT navigate away — there is nowhere obvious to go,
//   and a Cancel that loses unsaved input without leaving the page is
//   the standard expectation for an inline settings form.

import Link from "next/link"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { updateProfile } from "./actions"

type Props = {
  email: string
  initialFirstname: string
  initialLastname: string
}

export default function AccountForm({
  email,
  initialFirstname,
  initialLastname,
}: Props) {
  const [firstname, setFirstname] = useState(initialFirstname)
  const [lastname, setLastname] = useState(initialLastname)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const router = useRouter()

  function handleClose() {
    // history.length is at least 1 for the current entry. >1 means
    // there's somewhere to go back to within the tab's session. If the
    // user deep-linked or refreshed, length is 1 and router.back() would
    // leave the app entirely — fall back to the home page instead.
    if (window.history.length > 1) {
      router.back()
    } else {
      router.push("/")
    }
  }

  const dirty =
    firstname !== initialFirstname || lastname !== initialLastname

  async function onSubmit(formData: FormData) {
    setError(null)
    setSubmitting(true)
    try {
      await updateProfile(formData)
      // If updateProfile returns normally (no redirect, no throw), we
      // landed on this line. In practice it always either throws
      // NEXT_REDIRECT (success) or throws a real Error (failure). We
      // re-enable the form here just in case the action ever changes to
      // return without redirecting.
      setSubmitting(false)
    } catch (e) {
      // NEXT_REDIRECT is how Next.js implements redirect() in Server
      // Actions — it's a control-flow signal, not a real error. Let it
      // propagate so the navigation completes. Every other error is a
      // genuine failure we want to show.
      if (e && typeof e === "object" && "digest" in e &&
          typeof (e as { digest: unknown }).digest === "string" &&
          (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")) {
        throw e
      }
      setSubmitting(false)
      setError(e instanceof Error ? e.message : "Something went wrong.")
    }
  }

  function onCancel() {
    setFirstname(initialFirstname)
    setLastname(initialLastname)
    setError(null)
  }

  return (
    <>
      <h1 className="mb-1 text-2xl font-bold">Account settings</h1>
      <p className="mb-6 text-sm text-gray-600">
        Manage your profile. Signed in as <strong>{email}</strong>.
      </p>

      {error && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <form action={onSubmit} className="grid gap-4">
        <label className="grid gap-1">
          <span className="text-sm font-semibold">First name</span>
          <input
            name="firstname"
            value={firstname}
            onChange={(e) => setFirstname(e.target.value)}
            className="rounded border border-gray-300 p-2"
            maxLength={100}
            autoComplete="given-name"
          />
        </label>

        <label className="grid gap-1">
          <span className="text-sm font-semibold">Last name</span>
          <input
            name="lastname"
            value={lastname}
            onChange={(e) => setLastname(e.target.value)}
            className="rounded border border-gray-300 p-2"
            maxLength={100}
            autoComplete="family-name"
          />
        </label>

        <label className="grid gap-1">
          <span className="text-sm font-semibold">Email</span>
          <input
            value={email}
            readOnly
            disabled
            className="rounded border border-gray-200 bg-gray-50 p-2 text-gray-600"
            autoComplete="email"
          />
          <span className="text-xs text-gray-500">
            Email cannot be changed here yet.
          </span>
        </label>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={submitting || !dirty}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300"
          >
            {submitting ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting || !dirty}
            className="rounded border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
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

      <hr className="my-8 border-gray-200" />

      <div>
        <h2 className="mb-1 text-base font-semibold">Password</h2>
        <p className="mb-3 text-sm text-gray-600">
           Update your account password
        </p>
        <Link
          href="/account/password"
          className="inline-block rounded border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
        >
          Change password →
        </Link>
      </div>
    </>
  )
}
