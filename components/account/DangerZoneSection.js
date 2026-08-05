'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'

export default function DangerZoneSection({ email }) {
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [showDeletePassword, setShowDeletePassword] = useState(false)

  async function handleDeleteAccount() {
    setDeleteError('')

    if (!deletePassword) {
      setDeleteError('Enter your password to confirm.')
      return
    }

    // Re-authenticate first, so a walked-away-from session can't delete the
    // account on someone else's say-so.
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password: deletePassword })
    if (signInError) {
      setDeleteError('Incorrect password.')
      return
    }
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

  return (
    <>
      <div className="section-heading" style={{ marginTop: '8px' }}>Danger zone</div>
      <div className="panel danger-panel">
        <div className="danger-row">
          <div>
            <div className="danger-row-title">Delete your account</div>
            <div className="danger-row-note">This action cannot be undone.</div>
          </div>
          <button className="btn-danger-outline" onClick={() => { setDeletePassword(''); setDeleteError(''); setShowDeleteModal(true) }} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete account'}
          </button>
        </div>
      </div>

      {showDeleteModal && (
        <div className="confirm-modal-overlay" onClick={() => setShowDeleteModal(false)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete Account</h2>
            <p>This action is permanent and cannot be undone. All of your trading journal, strategies, performance data, and account information will be permanently deleted.</p>
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
            {deleteError && <div className="account-msg account-msg-error" style={{ marginTop: '10px' }}>{deleteError}</div>}
            <div className="submit-row">
              <button type="button" className="btn-danger-outline" onClick={() => setShowDeleteModal(false)}>Cancel</button>
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
