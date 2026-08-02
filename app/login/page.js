'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../lib/supabaseClient'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Two-factor step — only shown if the account has 2FA enabled
  const [step, setStep] = useState('password') // 'password' | 'mfa'
  const [mfaCode, setMfaCode] = useState('')
  const [mfaFactorId, setMfaFactorId] = useState(null)

  async function recordLoginEvent() {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      await supabase.from('login_events').insert([{ user_id: user.id, user_agent: navigator.userAgent }])
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

    if (levelData.nextLevel === 'aal2' && levelData.currentLevel !== 'aal2') {
      const { data: factorsData } = await supabase.auth.mfa.listFactors()
      const factor = factorsData?.totp?.[0]
      if (factor) {
        setMfaFactorId(factor.id)
        setStep('mfa')
        return
      }
    }

    await recordLoginEvent()
    router.push('/app')
  }

  async function handleMfaSubmit(e) {
    e.preventDefault()
    setError('')
    if (!mfaCode.trim()) {
      setError('Enter the 6-digit code from your authenticator app.')
      return
    }
    setLoading(true)
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
    setLoading(false)
    if (verifyError) {
      setError('Incorrect code — try again.')
      return
    }
    await recordLoginEvent()
    router.push('/app')
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="title">Edge<span>Log</span></div>

        {step === 'password' ? (
          <>
            <h1>Log in</h1>
            <form onSubmit={handlePasswordSubmit}>
              <div className="field full">
                <label>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="field full">
                <label>Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              {error && <div className="auth-error">{error}</div>}
              <button type="submit" disabled={loading} className="auth-submit">
                {loading ? 'Logging in…' : 'Log in'}
              </button>
            </form>
            <div className="auth-switch">
              No account yet? <a href="/signup">Sign up</a>
            </div>
          </>
        ) : (
          <>
            <h1>Two-factor code</h1>
            <p className="onboard-note">Enter the 6-digit code from your authenticator app.</p>
            <form onSubmit={handleMfaSubmit}>
              <div className="field full">
                <label>Code</label>
                <input
                  type="text" maxLength={6} autoFocus placeholder="123456"
                  value={mfaCode} onChange={(e) => setMfaCode(e.target.value)}
                />
              </div>
              {error && <div className="auth-error">{error}</div>}
              <button type="submit" disabled={loading} className="auth-submit">
                {loading ? 'Verifying…' : 'Verify'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
