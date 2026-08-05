'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { GoogleIcon } from '@/components/OAuthIcons'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

// Two-factor step - only shown if the account has 2FA enabled
const [step, setStep] = useState('password') // 'password' | 'mfa'
const [mfaCode, setMfaCode] = useState('')
  const [mfaFactorId, setMfaFactorId] = useState(null)

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
    setError('Incorrect code - try again.')
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
    Don't have an account? <a href="/signup">Sign up</a>
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
{loading ? 'Verifying...' : 'Verify'}
</button>
  </form>
  </>
)}
</div>
  </div>
)
}
