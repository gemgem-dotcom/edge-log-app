'use client'

import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { validatePassword } from '@/lib/validatePassword'

// Rendered inside the shared Security panel, so it contributes only its own
// title and fields — no .panel wrapper of its own.
export default function PasswordSection({ email }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordSuccess, setPasswordSuccess] = useState('')

  async function handleUpdatePassword() {
    setPasswordError('')
    setPasswordSuccess('')

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('Fill in all three password fields.')
      return
    }
    const passwordRuleError = validatePassword(newPassword)
    if (passwordRuleError) {
      setPasswordError(passwordRuleError)
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

  return (
    <>
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
              maxLength={15}
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
              maxLength={15}
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
            {passwordSaving ? 'Updating...' : 'Update password'}
          </button>
        </div>
      </form>
    </>
  )
}
