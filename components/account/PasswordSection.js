'use client'

import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { validatePassword } from '@/lib/validatePassword'

// Rendered inside the shared Security panel, so it contributes only its own
// title and fields — no .panel wrapper of its own.
export default function PasswordSection({ email, hasPassword, onPasswordSet }) {
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

    if (hasPassword && (!currentPassword || !newPassword || !confirmPassword)) {
      setPasswordError('Fill in all three password fields.')
      return
    }
    if (!hasPassword && (!newPassword || !confirmPassword)) {
      setPasswordError('Fill in both password fields.')
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

    // Google-only accounts have no password to re-check, and the user is
    // already authenticated via their current session - go straight to
    // setting one. Email/password accounts still re-confirm first.
    if (hasPassword) {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      })

      if (signInError) {
        setPasswordError('Current password is incorrect.')
        setPasswordSaving(false)
        return
      }
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })

    setPasswordSaving(false)

    if (updateError) {
      setPasswordError("Couldn't update your password. Please try again.")
      return
    }

    setPasswordSuccess(hasPassword ? 'Password updated.' : 'Password set. You can now log in with your email and this password, or continue using Google.')
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')

    // Without this, the parent's hasPassword (computed once on page load from
    // identities) stays stale for the rest of this visit - this form would
    // keep rendering as "Set a password" with no current-password field, and
    // DangerZoneSection would keep accepting just the word DELETE instead of
    // the password that now actually exists on the account.
    if (!hasPassword) onPasswordSet?.()
  }

  return (
    <>
      <div className="panel-title">{hasPassword ? 'Password' : 'Set a password'}</div>
      {!hasPassword && (
        <p className="onboard-note">
          You signed in with Google, so there&apos;s no password on this account yet. Set one below to also be able to log in with your email.
        </p>
      )}
      <form onSubmit={(e) => e.preventDefault()}>
        {hasPassword && (
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
        )}
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
            {passwordSaving ? (hasPassword ? 'Updating...' : 'Setting...') : (hasPassword ? 'Update password' : 'Set password')}
          </button>
        </div>
      </form>
    </>
  )
}
