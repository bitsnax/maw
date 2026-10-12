import type { Metadata } from "next";
import "./globals.css";
import SiteHeader from "./components/SiteHeader";
import "@fortawesome/fontawesome-svg-core/styles.css"
import { config } from "@fortawesome/fontawesome-svg-core"
config.autoAddCss = false

// NOTE: this file has NO "use client" — it stays a Server Component.
// It renders <SiteHeader/>, which IS a Client Component. A Server
// Component rendering a Client Component as a child is the normal,
// supported App Router pattern; the client boundary starts inside
// SiteHeader, not here. The layout itself does no session work.

export const metadata: Metadata = {
  title: "MAW",
  description: "Managed Agent Wrapper",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  )
}
