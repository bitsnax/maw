import { auth } from "@/lib/auth"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import Link from "next/link"

export default async function AdminDashboard() {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session) {
    redirect("/login")
  }

  if (session.user.role !== "admin") {
    redirect("/")
  }

  const sections = [
    { href: "/admin/users", title: "Users", desc: "Create users, change roles, ban accounts." },
  ]

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-bold mb-2">Admin</h1>
      <p className="text-gray-600 mb-6">Signed in as {session.user.email}</p>

      <div className="grid gap-3">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="block rounded border border-gray-200 p-4 hover:border-gray-400 hover:bg-gray-50"
          >
            <div className="font-semibold">{s.title}</div>
            <div className="text-sm text-gray-600">{s.desc}</div>
          </Link>
        ))}
      </div>
    </main>
  )
}
