'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { validatePassword } from '@/lib/validatePassword'
import { usePageTitle } from '@/lib/usePageTitle'

export default function ResetPasswordPage() {
  usePageTitle('Reset Password')
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [recoveryEvent, setRecoveryEvent] = useState(false)
  // Read once, during the first client render, before anything below has a
  // chance to strip the URL. PKCE turns the emailed recovery link into a
  // ?code= param (see lib/supabaseClient.js's flowType note); the hash form
  // covers a link issued before that. A bare visit to /reset-password by
  // someone who is merely signed in carries neither.
  const [recoveryLinkInUrl] = useState(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).has('code')
      || window.location.hash.includes('type=recovery')
  })

  useEffect(() => {
    // PASSWORD_RECOVERY only - deliberately NOT SIGNED_IN, and no
    // getSession() fallback. Both used to count, which meant merely holding
    // any live session was enough to set a new password here without
    // knowing the current one. That bypassed the re-authentication
    // components/account/PasswordSection.js enforces on the very same
    // action (it re-verifies via signInWithPassword first), so a stolen
    // cookie or an unattended logged-in browser could take the account over
    // permanently just by visiting this route.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setRecoveryEvent(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  // Derived, not stored: recoveryLinkInUrl is already known at first render,
  // so folding it in here rather than setting state from the effect avoids a
  // cascading re-render for a value that never changes. It covers the race
  // where detectSessionInUrl (see lib/supabaseClient.js) consumes the
  // recovery link and fires PASSWORD_RECOVERY before the effect subscribes -
  // arriving with a recovery code is itself proof of the emailed link,
  // unlike an existing session, which proves nothing about whether this
  // person knows the current password.
  const ready = recoveryLinkInUrl || recoveryEvent

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    // Not just the disabled submit button above - implicit submission
    // (Enter inside a text field) isn't reliably blocked by a disabled
    // button across browsers, and this is the check that actually protects
    // the account takeover described in the effect below.
    if (!ready) {
      setError('Open the reset link from your email to set a new password.')
      return
    }
    const passwordRuleError = validatePassword(password)
    if (passwordRuleError) {
      setError(passwordRuleError)
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    setLoading(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (updateError) {
      setError("Couldn't update your password. Your reset link may have expired — request a new one and try again.")
      return
    }
    setDone(true)
    setTimeout(() => router.push('/login'), 2500)
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">Edge<span>Log</span></div>
        {done ? (
          <>
            <h1 className="auth-welcome">Password updated</h1>
            <p className="auth-subtitle">Redirecting you to log in...</p>
          </>
        ) : (
          <>
            <h1 className="auth-welcome">Reset password</h1>
            <p className="auth-subtitle">
              {ready
                ? 'Enter a new password for your account.'
                : recoveryLinkInUrl
                  ? 'Verifying your reset link...'
                  : 'Open the reset link from your email to set a new password. To change a password you already know, use Account settings.'}
            </p>
            <form onSubmit={handleSubmit}>
              <div className="field full">
                <label>New password</label>
                <div className="password-field">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Enter your new password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    maxLength={15}
                    required
                  />
                  <button type="button" className="eye-btn" onClick={() => setShowPassword(!showPassword)}>
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <div className="field full">
                <label>Confirm new password</label>
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Confirm your new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  maxLength={15}
                  required
                />
              </div>
              {error && <div className="auth-error">{error}</div>}
              <button type="submit" disabled={loading || !ready} className="auth-submit">
                {loading ? 'Updating...' : 'Update password'}
              </button>
            </form>
          </>
        )}
      </div>

      <div className="auth-page-footer">
        <span>© 2026 EdgeLog</span>
      </div>
    </div>
  )
}
