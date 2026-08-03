'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { validatePassword } from '../../lib/validatePassword'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [ready, setReady] = useState(false)

useEffect(() => {
  const { data: sub } = supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
      setReady(true)
    }
  })
  supabase.auth.getSession().then(({ data }) => {
    if (data.session) setReady(true)
  })
  return () => sub.subscription.unsubscribe()
}, [])

async function handleSubmit(e) {
  e.preventDefault()
  setError('')
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
    setError(updateError.message)
    return
  }
  setDone(true)
  setTimeout(() => router.push('/login'), 2500)
}

return (
  <div className="auth-wrap">
  <div className="auth-card">
  <div className="auth-logo"><img src="/edgelog-logo.png" alt="EdgeLog" /></div>
{done ? (
  <>
  <h1 className="auth-welcome">Password updated</h1>
  <p className="auth-subtitle">Redirecting you to log in...</p>
  </>
  ) : (
    <>
    <h1 className="auth-welcome">Reset password</h1>
  <p className="auth-subtitle">
  {ready ? 'Enter a new password for your account.' : 'Verifying your reset link...'}
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
  </div>
)
}
