'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { verifiedFactors, preferredFactor } from '@/lib/mfaFactors'
import { checkAttemptAllowed, recordAttempt } from '@/lib/mfaAttemptClient'

const DELETE_CONFIRM_TEXT = 'DELETE'

export default function DangerZoneSection({ email, hasPassword }) {
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [showDeletePassword, setShowDeletePassword] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleteCode, setDeleteCode] = useState('')
  const [hasFactor, setHasFactor] = useState(false)

  // Whether this account has a second factor decides what proof the
  // modal asks for, so it is read when the modal opens rather than on
  // every page load.
  async function openDeleteModal() {
    setDeletePassword(''); setDeleteConfirmText(''); setDeleteCode(''); setDeleteError('')
    const { data } = await supabase.auth.mfa.listFactors()
    setHasFactor(verifiedFactors(data).length > 0)
    setShowDeleteModal(true)
  }

  async function handleDeleteAccount() {
    setDeleteError('')

    // WITH 2FA ON, THE PROOF IS A CODE, NOT THE PASSWORD. Two reasons,
    // and the second one is why this changed.
    //
    // It is stronger: a password typed into a walked-away-from session
    // proves only that the person knows the password, which is exactly
    // what a second factor exists to stop being sufficient.
    //
    // And signInWithPassword would actively break the deletion. A fresh
    // password grant on an account with a factor lands at aal1 - that
    // is the whole premise of the login page's challenge step - so
    // re-authenticating that way DOWNGRADES the session, and
    // /api/delete-account now requires aal2. Verifying a code elevates
    // the session instead, which is both the proof and the thing the
    // route needs.
    if (hasFactor) {
      if (!deleteCode.trim()) {
        setDeleteError('Enter the 6-digit code from your authenticator app.')
        return
      }
      const gate = await checkAttemptAllowed('reauth')
      if (!gate.allowed) { setDeleteError(gate.message); return }

      const { data: factorsData } = await supabase.auth.mfa.listFactors()
      const factor = preferredFactor(factorsData)
      if (!factor) { setDeleteError('No authenticator found on this account.'); return }

      const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({ factorId: factor.id })
      if (chErr) { setDeleteError("Couldn't check that code. Please try again."); return }
      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId: factor.id,
        challengeId: challenge.id,
        code: deleteCode.trim(),
      })
      const after = await recordAttempt('reauth', !vErr)
      if (vErr) {
        setDeleteError(after.message || 'Incorrect code - try again.')
        return
      }
    } else if (hasPassword) {
      if (!deletePassword) {
        setDeleteError('Enter your password to confirm.')
        return
      }
      // Re-authenticate first, so a walked-away-from session can't delete
      // the account on someone else's say-so.
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password: deletePassword })
      if (signInError) {
        setDeleteError('Incorrect password.')
        return
      }
    } else {
      // Google-only accounts have no password to re-check against, so
      // typing the confirmation word is what stands in for it here.
      if (deleteConfirmText.trim() !== DELETE_CONFIRM_TEXT) {
        setDeleteError(`Type ${DELETE_CONFIRM_TEXT} to confirm.`)
        return
      }
    }

    setDeleting(true)

    const { data: { session } } = await supabase.auth.getSession()
    const token = session ? session.access_token : null

    const res = await fetch('/api/delete-account', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
    })

    // A non-JSON body (a gateway error page, say) would otherwise throw here
    // and leave the button stuck on "Deleting...".
    const result = await res.json().catch(() => ({}))

    if (!res.ok) {
      // Only a non-empty string is usable as a message. Anything else — an
      // object, an empty string, nothing at all — would render as "{}" or a
      // blank error, which is what made this failure look silent.
      const message = typeof result?.error === 'string' && result.error.trim()
        ? result.error
        : 'Something went wrong deleting your account. Please try again or contact support.'
      setDeleteError(message)
      setDeleting(false)
      return
    }

    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <>
      <div className="section-heading" style={{ marginTop: '8px' }}>Danger zone</div>
      <div className="panel danger-panel">
        <div className="danger-row">
          <div>
            <div className="danger-row-title">Delete your account</div>
            <div className="danger-row-note">This action cannot be undone.</div>
          </div>
          <button
            className="btn-danger-outline"
            onClick={openDeleteModal}
            disabled={deleting}
          >
            {deleting ? 'Deleting...' : 'Delete account'}
          </button>
        </div>
      </div>

      {showDeleteModal && (
        <div className="confirm-modal-overlay" onClick={() => setShowDeleteModal(false)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete Account</h2>
            <p>This action is permanent and cannot be undone. Your trading journal, strategies, performance data, and account information will be permanently deleted.</p>
            {hasFactor ? (
              <>
                <p style={{ marginBottom: '6px' }}>Enter the 6-digit code from your authenticator app to confirm.</p>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="123456"
                  value={deleteCode}
                  onChange={(e) => setDeleteCode(e.target.value)}
                />
              </>
            ) : hasPassword ? (
              <>
                <p style={{ marginBottom: '6px' }}>Enter your password to confirm.</p>
                <div className="password-field">
                  <input
                    type={showDeletePassword ? 'text' : 'password'}
                    placeholder="Enter your password"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                  />
                  <button type="button" className="eye-btn" onClick={() => setShowDeletePassword(!showDeletePassword)}>
                    {showDeletePassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ marginBottom: '6px' }}>Type {DELETE_CONFIRM_TEXT} to confirm.</p>
                <input
                  type="text"
                  placeholder={DELETE_CONFIRM_TEXT}
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                />
              </>
            )}
            {deleteError && <div className="account-msg account-msg-error" style={{ marginTop: '10px' }}>{deleteError}</div>}
            <div className="submit-row">
              <button type="button" className="btn-accent-outline" onClick={() => setShowDeleteModal(false)}>Cancel</button>
              <button type="button" className="btn-danger-outline" onClick={handleDeleteAccount} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete account'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
