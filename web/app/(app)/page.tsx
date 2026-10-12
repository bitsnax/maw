import { adminSession } from "@/lib/admin-session"
import DashboardLive from "./DashboardLive"
import { dashboardSnapshot } from "./dashboard-actions"

// Dashboard: what is running now — OpenCode sessions working, or waiting for
// an answer — and recent sessions. Setup lives in Projects and Machines.

export const dynamic = "force-dynamic"

export default async function Dashboard() {
  const admin = await adminSession()
  return (
    <>
      <h1 className="app-title">Dashboard</h1>
      {admin ? <DashboardLive initial={await dashboardSnapshot()} /> : <p className="app-empty">Nothing to show: sessions are shown to admins.</p>}
    </>
  )
}
