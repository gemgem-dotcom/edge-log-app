'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { validatePassword } from '@/lib/validatePassword'
import { GoogleIcon } from '@/components/OAuthIcons'
import { usePageTitle } from '@/lib/usePageTitle'

export default function SignupPage() {
  usePageTitle('Sign Up')
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setMessage('')
    const passwordRuleError = validatePassword(password)
    if (passwordRuleError) {
      setError(passwordRuleError)
      return
    }
    setLoading(true)
    // tutorial_status: 'pending' is set right here, at the one unambiguous
    // "account created" moment this flow has - see lib/tutorial.js's own
    // comment on why an absent tutorial_status must never be treated as
    // 'pending' after the fact.
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { tutorial_status: 'pending' } },
    })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      // Cleared unconditionally here rather than gated behind any "is this
      // really new" heuristic (see lib/tutorialNewAccount.js's
      // resetThemeForNewAccount, used by the Google OAuth path instead) -
      // signUp() succeeding is itself the one unambiguous "account
      // created" moment, same reason tutorial_status is set directly
      // above rather than inferred. Runs regardless of which branch below
      // fires: a previous account signed out on this same browser would
      // otherwise leave its theme sitting in localStorage (see components/
      // AppShell.js) for this brand new account to inherit on its very
      // first render, whether that's immediately below or after the
      // trader confirms their email and logs in separately later.
      //
      // The attribute is set directly too, not just the storage key -
      // app/layout.js's inline script is the only other thing that applies
      // data-theme, and only on a hard navigation, so router.push below
      // (a client-side transition) would otherwise carry forward whatever
      // was already sitting on <html> from before this account existed.
      localStorage.removeItem('edgelog-theme')
      document.documentElement.setAttribute('data-theme', 'dark')
      if (data.session) {
        // Email confirmation is off — user is logged in immediately.
        router.push('/app')
      } else {
        // Email confirmation is on — they need to check their inbox first.
        setMessage('Check your email to confirm your account, then log in.')
      }
    }
  }

  async function handleOAuth(provider) {
    setError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    if (error) setError(error.message)
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">Edge<span>Log</span></div>
        <h1 className="auth-welcome">Create your account</h1>
        <form onSubmit={handleSubmit}>
          <div className="field full">
            <label>Email</label>
            <input type="email" placeholder="Enter your email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field full">
            <label>Password</label>
            <div className="password-field">
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button type="button" className="eye-btn" onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          {error && <div className="auth-error">{error}</div>}
          {message && <div className="auth-message">{message}</div>}
          <button type="submit" disabled={loading} className="auth-submit">
            {loading ? 'Creating account…' : 'Sign up'}
          </button>
        </form>

        <div className="auth-divider"><span>or continue with</span></div>
        <div className="auth-oauth-row">
          <button type="button" className="auth-oauth-btn" onClick={() => handleOAuth('google')}>
            <GoogleIcon size={16} /> Google
          </button>
        </div>

        <div className="auth-switch">
          Already have an account? <a href="/login">Log in</a>
        </div>
      </div>

      <div className="auth-page-footer">
        <span>© 2026 EdgeLog</span>
      </div>
    </div>
  )
}
