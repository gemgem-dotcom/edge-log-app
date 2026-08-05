'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { validatePassword } from '@/lib/validatePassword'
import { GoogleIcon } from '@/components/OAuthIcons'

export default function SignupPage() {
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
    const { data, error } = await supabase.auth.signUp({ email, password })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else if (data.session) {
      // Email confirmation is off — user is logged in immediately.
      router.push('/app')
    } else {
      // Email confirmation is on — they need to check their inbox first.
      setMessage('Check your email to confirm your account, then log in.')
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
        <p className="auth-subtitle">Start journaling your trades</p>
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
    </div>
  )
}
