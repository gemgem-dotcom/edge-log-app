'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff, ShieldAlert } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { validatePassword, PASSWORD_HINT_SHORT, PASSWORD_MAX_LENGTH } from '@/lib/validatePassword'
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

  // TWO-FACTOR, AND WHY THIS PAGE TOUCHES IT AT ALL.
  //
  // EdgeLog deliberately has no recovery codes. That makes this page the
  // only way back into an account whose authenticator is lost, and it
  // only works if finishing the reset also clears the factor - otherwise
  // the user sets a new password, is asked for a code they cannot
  // produce, and is locked out for good by the very flow meant to save
  // them.
  //
  // It is not done quietly. Switching someone's second factor off is a
  // real reduction in their account's security, so they are told in
  // plain words and have to agree to it before the reset will run.
  const [factorCount, setFactorCount] = useState(0)
  const [acceptsClearing, setAcceptsClearing] = useState(false)

  useEffect(() => {
    if (!ready) return
    let alive = true
    ;(async () => {
      const { data } = await supabase.auth.mfa.listFactors()
      // Verified only. An abandoned enrolment is not protection the user
      // relies on, and warning about one would be noise.
      const verified = (data?.totp || []).filter((f) => f?.status === 'verified')
      if (alive) setFactorCount(verified.length)
    })()
    return () => { alive = false }
  }, [ready])

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
    if (factorCount > 0 && !acceptsClearing) {
      setError('Tick the box to confirm you understand two-factor authentication will be turned off.')
      return
    }
    setLoading(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setLoading(false)
      setError("Couldn't update your password. Your reset link may have expired — request a new one and try again.")
      return
    }

    // Password first, factors second, and the order matters.
    //
    // Clearing first would mean an abandoned reset silently strips
    // someone's 2FA: they open the email, think better of it, close the
    // tab, and their account is weaker than before without them ever
    // confirming anything.
    //
    // The cost of this order is the window it leaves - a new password
    // set, the factor still in place - which is exactly the lockout this
    // feature exists to prevent. So the failure is never reported as
    // success, and the way out is stated: another reset link re-runs the
    // clear, because the user's new password is already in place and
    // this step is idempotent.
    if (factorCount > 0) {
      const cleared = await clearTwoFactor()
      setLoading(false)
      if (!cleared) {
        setError('Your password was changed, but two-factor authentication could not be switched off. Request another reset link to finish — your new password still works.')
        return
      }
    } else {
      setLoading(false)
    }

    setDone(true)
    setTimeout(() => router.push('/login'), 2500)
  }

  // Read the token fresh rather than closing over one: updateUser() can
  // issue a new access token, and the stale one would be rejected.
  async function clearTwoFactor() {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) return false
    try {
      const res = await fetch('/api/clear-2fa', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.ok
    } catch {
      // A network failure here is the same outcome as a refusal, and the
      // caller's message covers both. Throwing would leave the button
      // stuck on "Updating...".
      return false
    }
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
                    maxLength={PASSWORD_MAX_LENGTH}
                    required
                  />
                  <button type="button" className="eye-btn" onClick={() => setShowPassword(!showPassword)}>
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              {/* Stated before the attempt, not after it - the rule
                  used to be revealed only by failing it. One line, and
                  only the branch that always works; the error teaches
                  the shorter-with-symbols branch to the one person it
                  helps. */}
              <div className="field-hint" style={{ marginTop: '-6px', marginBottom: '14px' }}>
                {PASSWORD_HINT_SHORT}
              </div>
              <div className="field full">
                <label>Confirm new password</label>
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Confirm your new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  maxLength={PASSWORD_MAX_LENGTH}
                  required
                />
              </div>
              {/* Shown only when there is actually a factor to lose.
                  An account without 2FA should not be read a warning
                  about losing it - that is how people learn to click
                  past warnings without reading them. */}
              {factorCount > 0 && (
                <div className="reset-2fa-warning">
                  <div className="reset-2fa-warning-title">
                    <ShieldAlert size={15} aria-hidden="true" />
                    This will turn off two-factor authentication
                  </div>
                  <p>
                    {factorCount === 1
                      ? 'Your authenticator app will be removed from this account, so you can get back in without it.'
                      : `All ${factorCount} of your authenticators will be removed from this account, so you can get back in without them.`}
                    {' '}You can set it up again from Account settings once you have signed in.
                  </p>
                  <label className="reset-2fa-accept">
                    <input
                      type="checkbox"
                      checked={acceptsClearing}
                      onChange={(e) => setAcceptsClearing(e.target.checked)}
                    />
                    <span>I understand</span>
                  </label>
                </div>
              )}
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
