'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { needsSecondFactor, preferredFactor, verifiedFactors, factorLabel } from '@/lib/mfaFactors'
import { checkAttemptAllowed, recordAttempt } from '@/lib/mfaAttemptClient'
import { GoogleIcon } from '@/components/OAuthIcons'
import { usePageTitle } from '@/lib/usePageTitle'

export default function LoginPage() {
  usePageTitle('Log In')
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // If app/auth/callback/page.js sent us back here after a failed Google
  // sign-in, it's on the URL as ?error=oauth - shown the same way a failed
  // password attempt would be, but always this one generic message rather
  // than whatever the callback page's own failure actually was. That failure
  // is logged/visible server-side (Supabase's own auth logs) - surfacing its
  // raw text here has shown a real internal error string ("invalid flow
  // state, no valid flow state found") to a trader with no way to act on it,
  // which reads as far more alarming than "try again."
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('error')) {
      setError('There was a problem signing in with Google. Please try again, or contact support if this keeps happening.')
    }
  }, [])

  // Two-factor step - only shown if the account has 2FA enabled
  const [step, setStep] = useState('password') // 'password' | 'mfa'
  const [mfaCode, setMfaCode] = useState('')
  const [mfaFactorId, setMfaFactorId] = useState(null)
  // Every verified device, so somebody whose phone is flat can reach for
  // the tablet they deliberately enrolled as a spare. Before this the
  // login page read factors[0] and the spare was unreachable.
  const [mfaFactors, setMfaFactors] = useState([])
  const [pickingFactor, setPickingFactor] = useState(false)

  async function recordLoginEvent() {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session ? session.access_token : null
    if (!token) return
    try {
      await fetch('/api/record-login', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
      })
    } catch (e) {
      // best-effort - don't block login if logging fails
    }
  }

  async function handlePasswordSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError) {
      setError(signInError.message)
      setLoading(false)
      return
    }

    // Check whether this account needs a second factor before it's
    // actually fully authenticated (aal2).
    const { data: levelData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    setLoading(false)

    if (needsSecondFactor(levelData)) {
      const { data: factorsData } = await supabase.auth.mfa.listFactors()
      const factor = preferredFactor(factorsData)
      if (factor) {
        setMfaFactors(verifiedFactors(factorsData))
        setMfaFactorId(factor.id)
        setStep('mfa')
        return
      }
    }

    await recordLoginEvent()
    router.push('/app')
  }

  // Arriving already half-authenticated.
  //
  // proxy.js now bounces any /app request whose session has not cleared
  // its second factor, and sends it here with ?step=2fa. The commonest
  // way to be in that state is a password-recovery link, which mints a
  // live aal1 session without ever showing a code. Such a visitor has
  // already proved the first factor, so asking for the password again
  // would be theatre - and a bare login form with no explanation reads
  // as "it forgot I just reset my password".
  //
  // Deliberately keyed on the real assurance level rather than on the
  // query parameter: ?step=2fa is in the URL and anyone can type it, so
  // it decides only whether to LOOK, never what the answer is. A session
  // that does not need a second factor falls through untouched.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('step') !== '2fa') return
    let alive = true
    ;(async () => {
      const { data: levelData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (!alive || !needsSecondFactor(levelData)) return
      const { data: factorsData } = await supabase.auth.mfa.listFactors()
      const factor = preferredFactor(factorsData)
      if (!alive || !factor) return
      setMfaFactors(verifiedFactors(factorsData))
      setMfaFactorId(factor.id)
      setStep('mfa')
    })()
    return () => { alive = false }
  }, [])

  async function handleOAuth(provider) {
    setError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    if (error) setError(error.message)
  }

  async function handleMfaSubmit(e) {
    e.preventDefault()
    setError('')
    if (!mfaCode.trim()) {
      setError('Enter the 6-digit code from your authenticator app.')
      return
    }
    setLoading(true)

    // Asked BEFORE the code is sent, not only after. A lockout that
    // only appears once you have guessed again is not a lockout, and
    // the check also survives a page reload - which is the whole point
    // of counting server-side rather than in this component's state.
    const gate = await checkAttemptAllowed('totp')
    if (!gate.allowed) {
      setError(gate.message)
      setLoading(false)
      return
    }

    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: mfaFactorId })
    if (challengeError) {
      setError(challengeError.message)
      setLoading(false)
      return
    }
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: mfaFactorId,
      challengeId: challenge.id,
      code: mfaCode.trim(),
    })

    // Recorded either way. A limiter that only sees failures cannot
    // tell "five wrong then the real user got in" from "five wrong and
    // still going", and the first of those should clear the count.
    const after = await recordAttempt('totp', !verifyError)
    setLoading(false)

    if (verifyError) {
      setError(after.message || 'Incorrect code - try again.')
      return
    }
    await recordLoginEvent()
    router.push('/app')
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-logo">Edge<span>Log</span></div>

        {step === 'password' ? (
          <>
            <h1 className="auth-welcome">Welcome</h1>
            <p className="auth-subtitle">Please log in to continue</p>
            <form onSubmit={handlePasswordSubmit}>
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
              <div className="auth-forgot-row">
                <a href="/forgot-password" className="auth-forgot-link">Forgot password?</a>
              </div>
              {error && <div className="auth-error">{error}</div>}
              <button type="submit" disabled={loading} className="auth-submit">
                {loading ? 'Logging in...' : 'Log in'}
              </button>
            </form>

            <div className="auth-divider"><span>or continue with</span></div>
            <div className="auth-oauth-row">
              <button type="button" className="auth-oauth-btn" onClick={() => handleOAuth('google')}>
                <GoogleIcon size={16} /> Google
              </button>
            </div>

            <div className="auth-switch">
              Don&apos;t have an account? <a href="/signup">Sign up</a>
            </div>
          </>
        ) : (
          <>
            <h1>Two-factor code</h1>
            <p className="onboard-note">
              {pickingFactor
                ? 'Which device do you have with you?'
                : 'Enter the 6-digit code from your authenticator app.'}
            </p>
            {pickingFactor ? (
              /* Only reachable when more than one device is enrolled -
                 see the link below. A picker shown to somebody with a
                 single authenticator is a question with one answer. */
              <ul className="mfa-pick-list">
                {mfaFactors.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      className={`mfa-pick-btn${f.id === mfaFactorId ? ' is-current' : ''}`}
                      onClick={() => { setMfaFactorId(f.id); setPickingFactor(false); setError('') }}
                    >
                      {factorLabel(f)}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <form onSubmit={handleMfaSubmit}>
                <div className="field full">
                  <label>Code</label>
                  <input
                    type="text" inputMode="numeric" autoComplete="one-time-code"
                    maxLength={6} autoFocus placeholder="123456"
                    value={mfaCode} onChange={(e) => setMfaCode(e.target.value)}
                  />
                </div>
                {error && <div className="auth-error">{error}</div>}
                <button type="submit" disabled={loading} className="auth-submit">
                  {loading ? 'Verifying...' : 'Verify'}
                </button>
                {mfaFactors.length > 1 && (
                  <div className="auth-switch">
                    <a href="#" onClick={(e) => { e.preventDefault(); setPickingFactor(true) }}>
                      Use a different device
                    </a>
                  </div>
                )}
              </form>
            )}
          </>
        )}
      </div>
      <div className="auth-page-footer">
        <span>© 2026 EdgeLog</span>
      </div>
    </div>
  )
}
