// Server Component. Wraps every page under app/(auth)/, currently just
// /login but designed to also accept future /signup, /forgot-password,
// /verify-email, etc.
//
// Deliberately minimal: SiteHeader is already provided by the root
// layout, so an auth page gets the header + this centered shell + its
// own form. No sidebar, no breadcrumbs — auth pages are focused tasks
// where extra navigation chrome is a distraction.
//
// Styling lives in app/globals.css under "Layout shells".

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <div className="auth-shell">{children}</div>
}
