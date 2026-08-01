'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff, ArrowLeft } from 'lucide-react'
import { supabase } from '../../../lib/supabaseClient'

export default function AccountPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')

const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordSuccess, setPasswordSuccess] = useState('')

const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

useEffect(() => {
  loadData()
}, [])

async function loadData() {
  const { data: { user } } = await supabase.auth.getUser()
  setEmail(user.email)
  setFullName(user.user_metadata && user.user_metadata.full_name ? user.user_metadata.full_name : '')
  setLoading(false)
}

async function handleNameBlur() {
  await supabase.auth.updateUser({ data: { full_name: fullName.trim() } })
}

async function handleUpdatePassword() {
  setPasswordError('')
  setPasswordSuccess('')

  if (!currentPassword || !newPassword || !confirmPassword) {
    setPasswordError('Fill in all three password fields.')
    return
  }
  if (newPassword.length < 6) {
    setPasswordError('New password must be at least 6 characters.')
    return
  }
  if (newPassword !== confirmPassword) {
    setPasswordError('New password and confirmation do not match.')
    return
  }

  setPasswordSaving(true)

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password: currentPassword,
  })

  if (signInError) {
    setPasswordError('Current password is incorrect.')
    setPasswordSaving(false)
    return
  }

  const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })

  setPasswordSaving(false)

  if (updateError) {
    setPasswordError(updateError.message)
    return
  }

  setPasswordSuccess('Password updated.')
  setCurrentPassword('')
  setNewPassword('')
  setConfirmPassword('')
}

async function handleDeleteAccount() {
  setDeleteError('')
  const sure = confirm('Are you sure you want to permanently delete your account? This will erase every instrument, strategy, and trade you have logged, and cannot be undone.')
  if (!sure) return

  setDeleting(true)

  const { data: { session } } = await supabase.auth.getSession()
  const token = session ? session.access_token : null

  const res = await fetch('/api/delete-account', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
  })

  const result = await res.json()

  if (!res.ok) {
    setDeleteError(result.error || 'Could not delete account.')
    setDeleting(false)
    return
  }

  await supabase.auth.signOut()
  router.push('/login')
}

if (loading) return <div className="page-loading">Loading…</div>

return (
  <div>
  <div className="account-topbar">
  <div className="shell-logo">Edge<span>Log</span></div>
  <a href="/app" className="back-btn"><ArrowLeft size={16} /> Back to dashboard</a>
  </div>

<div className="account-wrap">
  <h1 className="page-title">Account Settings</h1>
  <p className="page-subtitle">Manage your account and preferences.</p>

<div className="panel">
  <div className="panel-title">Profile</div>
  <form onSubmit={(e) => e.preventDefault()}>
<div className="field half">
  <label>Full name</label>
<input
type="text"
value={fullName}
onChange={(e) => setFullName(e.target.value)}
onBlur={handleNameBlur}
/>
  </div>
<div className="field half">
  <label>Email</label>
<input type="email" value={email} disabled />
  </div>
  </form>
  </div>

<div className="panel">
  <div className="panel-title">Password</div>
<form onSubmit={(e) => e.preventDefault()}>
<div className="field wide">
  <label>Current password</label>
<div className="password-field">
  <input
type={showCurrent ? 'text' : 'password'}
placeholder="Enter current password"
value={currentPassword}
onChange={(e) => setCurrentPassword(e.target.value)}
/>
  <button type="button" className="eye-btn" onClick={() => setShowCurrent(!showCurrent)}>
{showCurrent ? <EyeOff size={16} /> : <Eye size={16} />}
</button>
  </div>
  </div>
 <div className="field wide">
  <label>New password</label>
 <div className="password-field">
  <input
 type={showNew ? 'text' : 'password'}
placeholder="Enter new password"
value={newPassword}
onChange={(e) => setNewPassword(e.target.value)}
/>
  <button type="button" className="eye-btn" onClick={() => setShowNew(!showNew)}>
{showNew ? <EyeOff size={16} /> : <Eye size={16} />}
</button>
  </div>
  </div>
 <div className="field wide">
  <label>Confirm new password</label>
 <div className="password-field">
  <input
 type={showConfirm ? 'text' : 'password'}
placeholder="Confirm new password"
value={confirmPassword}
onChange={(e) => setConfirmPassword(e.target.value)}
/>
  <button type="button" className="eye-btn" onClick={() => setShowConfirm(!showConfirm)}>
{showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
</button>
  </div>
  </div>

 {passwordError && <div className="field full account-msg account-msg-error">{passwordError}</div>}
  {passwordSuccess && <div className="field full account-msg account-msg-success">{passwordSuccess}</div>}

  <div className="submit-row">
    <button type="button" onClick={handleUpdatePassword} disabled={passwordSaving}>
  {passwordSaving ? 'Updating…' : 'Update password'}
  </button>
    </div>
    </form>
    </div>

 <div className="panel danger-panel">
    <div className="panel-title">Danger zone</div>
  <div className="danger-row">
    <div>
    <div className="danger-row-title">Delete your account</div>
  <div className="danger-row-note">This action cannot be undone.</div>
    </div>
  <button className="btn-danger-outline" onClick={handleDeleteAccount} disabled={deleting}>
  {deleting ? 'Deleting…' : 'Delete account'}
 </button>
   </div>
 {deleteError && <div className="account-msg account-msg-error" style={{ marginTop: '14px' }}>{deleteError}</div>}
   </div>
   </div>
   </div>
)
}
