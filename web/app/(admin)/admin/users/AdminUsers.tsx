"use client"

// Client UI for user management. The SERVER already proved (in page.tsx via
// auth.api.getSession) that the viewer is an admin before this component was
// ever rendered. This file is the "what you can do," not the "are you
// allowed" — that decision was made server-side and cannot be bypassed from
// here.
//
// All authClient.admin.* signatures below were verified against the Better
// Auth 1.6.11 admin-plugin docs (signatures differ between versions; the
// listUsers response shape — data.users / data.total — is the part that
// varies, so it was confirmed explicitly):
//   listUsers({ query: { limit, offset } })  -> { data: { users, total } }
//   createUser({ name, email, password, role })
//   setRole({ userId, role })
//   banUser({ userId, banReason })
//   unbanUser({ userId })
// All return { data, error } like signIn.email.

import { useState, useEffect, useCallback } from "react"
import { authClient } from "@/lib/auth-client"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import {
  faUserPlus,
  faBan,
  faUserCheck,
  faSpinner,
  faCircleExclamation,
  faCircleCheck,
} from "@fortawesome/free-solid-svg-icons"

type AdminUser = {
  id: string
  email: string
  name: string | null
  role: string | null
  banned: boolean | null
}

const PAGE_SIZE = 25
// Mirror lib/auth.ts emailAndPassword.minPasswordLength so the admin gets
// an immediate message instead of a server rejection on create.
const MIN_PASSWORD = 10

// Better Auth 1.6.11 INFERS this union from lib/auth.ts:
//   admin({ defaultRole: "user", adminRole: "admin" })
// so createUser/setRole only accept "user" | "admin" (or arrays of them),
// NOT an arbitrary string. The Prisma schema's @default("viewer") is a DB
// default only — "viewer" is NOT a role the admin API will accept, so it
// is deliberately absent here. Typing this correctly (instead of casting)
// is what prevents a runtime failure that would otherwise look fine.
type Role = "user" | "admin"

export default function AdminUsers({ adminEmail }: { adminEmail: string }) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // create-user form
  const [nName, setNName] = useState("")
  const [nEmail, setNEmail] = useState("")
  const [nPassword, setNPassword] = useState("")
  const [nRole, setNRole] = useState<Role>("user")
  const [creating, setCreating] = useState(false)

  type ListResult = Awaited<ReturnType<typeof authClient.admin.listUsers>>

  // Store a listUsers() answer. Verified 1.6.11 shape: data.users (array),
  // data.total (count).
  const applyResult = useCallback(({ data, error: e }: ListResult) => {
    if (e) {
      setError(e.message ?? "Failed to load users.")
      setLoading(false)
      return
    }
    setUsers((data?.users as AdminUser[]) ?? [])
    setTotal(data?.total ?? 0)
    setLoading(false)
  }, [])

  // Reload after a change: show the loading state, then fetch.
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    applyResult(await authClient.admin.listUsers({
      query: { limit: PAGE_SIZE, offset: 0 },
    }))
  }, [applyResult])

  // First load: loading already starts true and error null, so state is
  // set only in the promise callback (never synchronously in the effect).
  useEffect(() => {
    let cancelled = false
    authClient.admin
      .listUsers({ query: { limit: PAGE_SIZE, offset: 0 } })
      .then((result) => {
        if (!cancelled) applyResult(result)
      })
    return () => {
      cancelled = true
    }
  }, [applyResult])

  async function handleCreate() {
    setError(null)
    setNotice(null)
    if (!nEmail || !nPassword) {
      setError("Email and password are required.")
      return
    }
    if (nPassword.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`)
      return
    }
    setCreating(true)
    const { error: e } = await authClient.admin.createUser({
      name: nName || nEmail,
      email: nEmail,
      password: nPassword,
      role: nRole,
    })
    setCreating(false)
    if (e) {
      setError(e.message ?? "Failed to create user.")
      return
    }
    setNotice(`Created ${nEmail}.`)
    setNName("")
    setNEmail("")
    setNPassword("")
    setNRole("user")
    load()
  }

  async function handleSetRole(userId: string, role: Role) {
    setError(null)
    setNotice(null)
    const { error: e } = await authClient.admin.setRole({ userId, role })
    if (e) {
      setError(e.message ?? "Failed to change role.")
      return
    }
    setNotice("Role updated.")
    load()
  }

  async function handleBanToggle(u: AdminUser) {
    setError(null)
    setNotice(null)
    if (u.banned) {
      const { error: e } = await authClient.admin.unbanUser({ userId: u.id })
      if (e) {
        setError(e.message ?? "Failed to unban user.")
        return
      }
      setNotice(`Unbanned ${u.email}.`)
    } else {
      const { error: e } = await authClient.admin.banUser({
        userId: u.id,
        banReason: "Banned by admin.",
      })
      if (e) {
        setError(e.message ?? "Failed to ban user.")
        return
      }
      setNotice(`Banned ${u.email}.`)
    }
    load()
  }

  return (
    <main className="mx-auto max-w-4xl px-5 pt-8 pb-16">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">User Management</h1>
        <p className="mt-1 text-sm text-gray-600">
          Signed in as {adminEmail} · {total} user{total === 1 ? "" : "s"}
        </p>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          <FontAwesomeIcon icon={faCircleExclamation} />
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 flex items-center gap-2 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700">
          <FontAwesomeIcon icon={faCircleCheck} />
          {notice}
        </div>
      )}

      <section className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-1 text-base font-semibold">Create user</h2>
        <p className="mb-4 text-sm text-gray-600">
          Public sign-up is disabled (disableSignUp: true). New accounts can
          only be created here.
        </p>
        <div className="grid grid-cols-[1fr_1fr_1fr_0.6fr_auto] items-center gap-2">
          <input
            className="rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="Name"
            value={nName}
            onChange={(e) => setNName(e.target.value)}
          />
          <input
            className="rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="Email"
            type="email"
            value={nEmail}
            onChange={(e) => setNEmail(e.target.value)}
          />
          <input
            className="rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder={`Password (min ${MIN_PASSWORD})`}
            type="password"
            value={nPassword}
            onChange={(e) => setNPassword(e.target.value)}
          />
          <select
            className="rounded border border-gray-300 px-3 py-2 text-sm"
            value={nRole}
            onChange={(e) => setNRole(e.target.value as Role)}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className={`inline-flex items-center gap-1.5 rounded bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-blue-300 ${
              creating ? "cursor-not-allowed" : "cursor-pointer"
            }`}
          >
            <FontAwesomeIcon
              icon={creating ? faSpinner : faUserPlus}
              spin={creating}
            />
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="mb-3 text-base font-semibold">Users</h2>
        {loading ? (
          <p className="inline-flex items-center gap-2 text-sm text-gray-600">
            <FontAwesomeIcon icon={faSpinner} spin />
            Loading…
          </p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="border-b-2 border-gray-200 px-2 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                  Email
                </th>
                <th className="border-b-2 border-gray-200 px-2 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                  Name
                </th>
                <th className="border-b-2 border-gray-200 px-2 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                  Role
                </th>
                <th className="border-b-2 border-gray-200 px-2 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                  Status
                </th>
                <th className="border-b-2 border-gray-200 px-2 py-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="border-b border-gray-100 px-2 py-2">
                    {u.email}
                  </td>
                  <td className="border-b border-gray-100 px-2 py-2">
                    {u.name ?? "—"}
                  </td>
                  <td className="border-b border-gray-100 px-2 py-2">
                    <select
                      className="rounded border border-gray-300 px-2 py-1 text-sm"
                      value={u.role ?? "user"}
                      onChange={(e) =>
                        handleSetRole(u.id, e.target.value as Role)
                      }
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="border-b border-gray-100 px-2 py-2">
                    {u.banned ? (
                      <span className="font-semibold text-red-600">banned</span>
                    ) : (
                      <span className="font-semibold text-green-700">
                        active
                      </span>
                    )}
                  </td>
                  <td className="border-b border-gray-100 px-2 py-2">
                    {u.banned ? (
                      <button
                        type="button"
                        onClick={() => handleBanToggle(u)}
                        className="cursor-pointer inline-flex items-center gap-1.5 rounded border border-gray-300 bg-gray-100 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-200 hover:border-gray-400"
                      >
                        <FontAwesomeIcon icon={faUserCheck} />
                        Unban
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleBanToggle(u)}
                        className="cursor-pointer inline-flex items-center gap-1.5 rounded border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-100"
                      >
                        <FontAwesomeIcon icon={faBan} />
                        Ban
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  )
}