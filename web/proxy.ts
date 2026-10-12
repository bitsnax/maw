import { NextRequest, NextResponse } from "next/server"

// ---------------------------------------------------------------------------
// Route protection — OPTIMISTIC redirect only.
//
// This is intentionally NOT the security boundary. Per Better Auth's docs,
// a cookie-presence check does not validate the session — anyone can forge
// a cookie. Real validation happens server-side in protected pages via
// auth.api.getSession() (see the admin page). This file's only job: bounce
// obviously-logged-out visitors to /login cheaply, on every request, with
// NO database call (proxy runs before rendering and on every navigation —
// a DB hit here would tax the whole app).
//
// FILE CONVENTION: Next.js 16 renamed middleware.ts -> proxy.ts and the
// exported function MUST be named `proxy` (or be a default export). A file
// named proxy.ts that exports `middleware` is silently NOT run by Next.js
// 16 — an invisible auth bypass. This file is /opt/maw/web/proxy.ts at the
// same level as app/.
//
// We check the cookie DIRECTLY instead of using better-auth's
// getSessionCookie() helper: that helper has a documented bug returning
// null on Next.js 16 (this project is on 16.2.1), which would cause an
// infinite redirect loop. A direct presence check has no version risk.
//
// Cookie name was VERIFIED from the live browser (Cookie-Editor), not
// assumed: on this HTTPS origin Better Auth uses the __Secure- prefix.
// ---------------------------------------------------------------------------

const SECURE_COOKIE = "__Secure-better-auth.session_token"
const PLAIN_COOKIE = "better-auth.session_token" // fallback for non-HTTPS dev

export function proxy(request: NextRequest) {
  const hasSession =
    request.cookies.has(SECURE_COOKIE) || request.cookies.has(PLAIN_COOKIE)

  if (!hasSession) {
    const loginUrl = new URL("/login", request.url)
    // Preserve where they were headed so we can send them back after login.
    loginUrl.searchParams.set("redirect", request.nextUrl.pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

// The matcher decides WHICH requests proxy runs on. We must exclude:
//   - /login            (or a logged-out user redirects to /login forever)
//   - /api/auth/*        (the sign-in endpoint must work BEFORE a cookie exists)
//   - /api/tools/*       (maw-opencode's tools; they carry MAW_TOOLS_TOKEN, checked
//                         in lib/tools.ts, and never have a sign-in cookie)
//   - /_next/*           (Next.js build assets — never redirect the JS bundle)
//   - common static files (favicon, icons, manifest, robots)
// Everything else requires a session cookie.
export const config = {
  matcher: [
    "/((?!login|api/auth|api/tools|_next/static|_next/image|favicon.ico|favicon-16x16.png|favicon-32x32.png|apple-touch-icon.png|android-chrome-192x192.png|android-chrome-512x512.png|site.webmanifest).*)",
  ],
}
