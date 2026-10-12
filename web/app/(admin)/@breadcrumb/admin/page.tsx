import { Breadcrumbs } from "@/app/components/Breadcrumbs"

// Home › Admin

export default function AdminDashboardBreadcrumb() {
  return (
    <Breadcrumbs trail={[
      { kind: "link", href: "/", label: "Home" },
      { kind: "current", label: "Admin" },
    ]} />
  )
}