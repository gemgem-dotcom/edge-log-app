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
  // Arriving from the login page's "lost your phone" route. Read once
  // at first render, before anything strips the URL. It only changes
  // the wording - the flow is identical either way.
  const [lostPhone] = useState(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).has('lost')
  })

async function handleSubmit(e) {
  e.preventDefault()
  setError('')
  setLoading(true)
  const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/reset-password',
  })
  setLoading(false)
  if (resetError) {
    // Deliberately NOT resetError.message, and deliberately not even a
    // failure: the success screen below is already non-committal about
    // whether the address exists, and surfacing the server's text here
    // would undo that. A genuine outage is reported, but nothing that
    // distinguishes a known address from an unknown one.
    if (/rate|too many/i.test(resetError.message || '')) {
      setError('Too many requests just now. Please wait a minute and try again.')
      return
    }
    setSent(true)
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
    <h1 className="auth-welcome">{lostPhone ? 'Get back into your account' : 'Forgot password?'}</h1>
  <p className="auth-subtitle">
    {lostPhone
      ? "Enter your email and we'll send you a link to set a new password. Opening it also switches off the sign-in code, so you can get in without your old phone."
      : "Enter your email and we'll send you a reset link. Use this too if you've lost the phone that gives you your sign-in code."}
  </p>
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
