'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { formatInTz } from '@/lib/timezone'
import { useConfirm } from '@/lib/useConfirm'

// Rendered inside the shared Security panel, so it contributes only its own
// title and body — no .panel wrapper of its own.
export default function SignInHistorySection({ initialEvents, timezone }) {
  const router = useRouter()
  const [loginEvents, setLoginEvents] = useState(initialEvents)
  const { confirm, modal: confirmModal } = useConfirm()
  const [showAllEvents, setShowAllEvents] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessionMessage, setSessionMessage] = useState('')
  const [editingDeviceId, setEditingDeviceId] = useState(null)
  const [nicknameInput, setNicknameInput] = useState('')
  const [nicknameError, setNicknameError] = useState('')

  async function handleSignOutOthers() {
    setSessionMessage('')
    setSessionBusy(true)
    const { error } = await supabase.auth.signOut({ scope: 'others' })
    setSessionBusy(false)
    setSessionMessage(error ? "Couldn't sign out other devices. Please try again." : 'Signed out of all other devices.')
  }

  async function handleSignOutEverywhere() {
    const sure = await confirm({
      title: 'Sign Out Everywhere',
      message: 'You will need to log in again on every device, including this one.',
      confirmLabel: 'Log out everywhere',
      danger: true,
    })
    if (!sure) return
    await supabase.auth.signOut({ scope: 'global' })
    router.push('/login')
  }

  async function handleSaveNickname(eventId) {
    setNicknameError('')
    const trimmed = nicknameInput.trim()
    const { data, error } = await supabase
      .from('login_events')
      .update({ device_nickname: trimmed || null })
      .eq('id', eventId)
      .select()
    // RLS silently blocking the write (no matching row updated) looks
    // identical to success unless the returned rows are checked - without
    // this, a blocked rename would show as saved.
    if (!error && data && data.length > 0) {
      setLoginEvents((prev) => prev.map((ev) => (ev.id === eventId ? { ...ev, device_nickname: trimmed || null } : ev)))
    } else {
      setNicknameError('Could not save that nickname. Please try again.')
    }
    setEditingDeviceId(null)
    setNicknameInput('')
  }

  const visibleEvents = showAllEvents ? loginEvents : loginEvents.slice(0, 5)

  return (
    <>
      <div className="panel-title">Recent sign-ins</div>
      <p className="onboard-note" style={{ marginTop: '-8px' }}>These are devices that have recently signed in to your account. If you don&apos;t recognise any of these devices, we recommend logging out of all devices and changing your password.</p>
      {loginEvents.length === 0 ? (
        <div className="empty" style={{ padding: '14px' }}>No sign-in history yet.</div>
      ) : (
        <>
          {nicknameError && <div className="account-msg account-msg-error">{nicknameError}</div>}
          <div className="signin-table-wrap">
          <table>
            <thead><tr><th>Device</th><th>Location</th><th>Date &amp; time</th></tr></thead>
            <tbody>
              {visibleEvents.map((ev) => (
                <tr key={ev.id}>
                  <td>
                    {editingDeviceId === ev.id ? (
                      <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                        <input type="text" value={nicknameInput} onChange={(e) => setNicknameInput(e.target.value)} placeholder={ev.device || 'Unknown device'} style={{ padding: '4px 8px', fontSize: '13px', width: '140px' }} autoFocus />
                        <span className="del save-link" onClick={() => handleSaveNickname(ev.id)}>Save</span>
                        <span className="del" onClick={() => { setEditingDeviceId(null); setNicknameInput('') }}>Cancel</span>
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                        {ev.device_nickname || ev.device || 'Unknown device'}
                        <Pencil size={12} className="icon-edit-btn" onClick={() => { setEditingDeviceId(ev.id); setNicknameInput(ev.device_nickname || '') }} />
                      </span>
                    )}
                  </td>
                  <td>{ev.location || 'Unknown location'}</td>
                  <td>{formatInTz(ev.created_at, timezone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {loginEvents.length > 5 && (
            <div className="panel-link-row">
              <span className="panel-link" style={{ cursor: 'pointer' }} onClick={() => setShowAllEvents(!showAllEvents)}>
                {showAllEvents ? 'Show fewer' : `Show all ${loginEvents.length} sign-ins`}
              </span>
            </div>
          )}
        </>
      )}

      <div className="submit-row" style={{ justifyContent: 'flex-start', gap: '10px', marginTop: '16px' }}>
        <button type="button" onClick={handleSignOutOthers} disabled={sessionBusy}>Log out of all other devices</button>
        <button type="button" className="btn-danger-outline" onClick={handleSignOutEverywhere}>Log out everywhere</button>
      </div>
      {sessionMessage && <div className="account-msg account-msg-success">{sessionMessage}</div>}
      {confirmModal}
    </>
  )
}
