import { redirect } from "next/navigation"

// Sessions are worked in on the Dashboard; old links land there.
export default async function SessionPage({ params }: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await params
  redirect(`/?project=${encodeURIComponent(id)}&session=${encodeURIComponent(sid)}`)
}
