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

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      router.push('/app')
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="title">Edge<span>Log</span></div>
        <h1>Log in</h1>
        <form onSubmit={handleSubmit}>
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
      </div>
    </div>
  )
}
