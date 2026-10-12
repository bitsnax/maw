"use client"

// WHY "use client": this component uses React state and calls
// signIn.email(), which is a browser-side function. It performs a
// fetch to /api/auth/sign-in/email; the server's nextCookies() plugin
// attaches the session cookie to that response. A Server Component
// could not hold form state or call the client auth function.

import { useState } from "react"
import { useRouter } from "next/navigation"
import { signIn } from "@/lib/auth-client"

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    // Mirror lib/auth.ts minPasswordLength: 10 client-side so the user
    // gets an immediate message instead of a round-trip rejection.
    if (password.length < 10) {
      setError("Password must be at least 10 characters.")
      return
    }

    setSubmitting(true)

    // signIn.email returns { data, error } — it does NOT throw on bad
    // credentials. We branch on `error`, not a try/catch.
    const { error: signInError } = await signIn.email({
      email,
      password,
    })

    if (signInError) {
      setError(signInError.message ?? "Sign-in failed.")
      setSubmitting(false)
      return
    }

    // Success: the session cookie is now set. router.refresh() forces
    // the server to re-read it so middleware/Server Components see the
    // authenticated state. Then navigate to the app root.
    router.refresh()
    router.push("/")
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1 className="login-title">MAW</h1>
        <p className="login-sub">Sign in to continue</p>

        <label className="login-label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="login-input"
        />

        <label className="login-label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="login-input"
        />

        {error && <p className="login-error">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="login-button"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <style>{`
        .login-shell {
          min-height: 100vh;
          display: grid;
          place-items: center;
          background:
            radial-gradient(circle at 20% 20%, #1b2440 0, transparent 55%),
            radial-gradient(circle at 80% 80%, #241b40 0, transparent 55%),
            #0c0f1a;
          font-family: ui-sans-serif, system-ui, sans-serif;
          padding: 1.5rem;
        }
        .login-card {
          width: 100%;
          max-width: 380px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.09);
          border-radius: 16px;
          padding: 2.25rem 2rem;
          backdrop-filter: blur(12px);
          box-shadow: 0 24px 60px -20px rgba(0,0,0,0.7);
        }
        .login-title {
          margin: 0;
          font-size: 1.6rem;
          font-weight: 650;
          letter-spacing: -0.02em;
          color: #f4f6fb;
        }
        .login-sub {
          margin: 0.35rem 0 1.75rem;
          font-size: 0.9rem;
          color: #9aa3b8;
        }
        .login-label {
          display: block;
          font-size: 0.78rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: #8a93ab;
          margin-bottom: 0.4rem;
        }
        .login-input {
          width: 100%;
          box-sizing: border-box;
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 9px;
          padding: 0.7rem 0.85rem;
          color: #eef1f8;
          font-size: 0.95rem;
          margin-bottom: 1.1rem;
          outline: none;
          transition: border-color .15s, box-shadow .15s;
        }
        .login-input:focus {
          border-color: #6c8cff;
          box-shadow: 0 0 0 3px rgba(108,140,255,0.18);
        }
        .login-error {
          margin: 0 0 1rem;
          color: #ff9a9a;
          font-size: 0.85rem;
          background: rgba(255,80,80,0.08);
          border: 1px solid rgba(255,80,80,0.25);
          padding: 0.55rem 0.7rem;
          border-radius: 8px;
        }
        .login-button {
          width: 100%;
          background: linear-gradient(135deg, #5b7cff, #8a5bff);
          color: #fff;
          font-size: 0.95rem;
          font-weight: 600;
          border: none;
          border-radius: 9px;
          padding: 0.8rem;
          cursor: pointer;
          transition: opacity .15s, transform .05s;
        }
        .login-button:hover { opacity: 0.92; }
        .login-button:active { transform: translateY(1px); }
        .login-button:disabled { opacity: 0.55; cursor: not-allowed; }
      `}</style>
    </main>
  )
}
