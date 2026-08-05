'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { validatePassword } from '@/lib/validatePassword'

export default function SignupPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
          setLoading(false)
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

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="title">Edge<span>Log</span></div>
        <h1>Create your account</h1>
        <form onSubmit={handleSubmit}>
          <div className="field full">
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field full">
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={15} />
          </div>
          {error && <div className="auth-error">{error}</div>}
          {message && <div className="auth-message">{message}</div>}
          <button type="submit" disabled={loading} className="auth-submit">
            {loading ? 'Creating account…' : 'Sign up'}
          </button>
        </form>
        <div className="auth-switch">
          Already have an account? <a href="/login">Log in</a>
        </div>
      </div>
    </div>
  )
}
