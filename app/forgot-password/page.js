'use client'

import { useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { usePageTitle } from '@/lib/usePageTitle'

export default function ForgotPasswordPage() {
  usePageTitle('Forgot Password')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

async function handleSubmit(e) {
  e.preventDefault()
  setError('')
  setLoading(true)
  const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/reset-password',
  })
  setLoading(false)
  if (resetError) {
    setError(resetError.message)
    return
  }
  setSent(true)
}

return (
  <div className="auth-wrap">
  <div className="auth-card">
  <div className="auth-logo">Edge<span>Log</span></div>
{sent ? (
  <>
  <h1 className="auth-welcome">Check your email</h1>
  <p className="auth-subtitle">We&apos;ve sent a password reset link to {email}.</p>
  <div className="auth-switch">
  <Link href="/login">Back to log in</Link>
  </div>
  </>
  ) : (
    <>
    <h1 className="auth-welcome">Forgot password?</h1>
  <p className="auth-subtitle">Enter your email and we&apos;ll send you a reset link.</p>
    <form onSubmit={handleSubmit}>
    <div className="field full">
    <label>Email</label>
  <input type="email" placeholder="Enter your email" value={email} onChange={(e) => setEmail(e.target.value)} required />
  </div>
{error && <div className="auth-error">{error}</div>}
 <button type="submit" disabled={loading} className="auth-submit">
{loading ? 'Sending...' : 'Send reset link'}
</button>
  </form>
<div className="auth-switch">
  Remembered your password? <Link href="/login">Log in</Link>
  </div>
  </>
)}
</div>

  <div className="auth-page-footer">
    <span>© 2026 EdgeLog</span>
  </div>
  </div>
)
}
