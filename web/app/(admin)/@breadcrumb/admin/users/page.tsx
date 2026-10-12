import { Breadcrumbs } from "@/app/components/Breadcrumbs"

// Home › Admin › Users

export default function AdminUsersBreadcrumb() {
  return (
    <Breadcrumbs trail={[
      { kind: "link", href: "/", label: "Home" },
      { kind: "link", href: "/admin", label: "Admin" },
      { kind: "current", label: "Users" },
    ]} />
  )
}
