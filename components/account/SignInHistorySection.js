'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { formatLocal, relativeTime } from '@/lib/timezone'
import { parseDevice } from '@/lib/deviceLabel'
import { useConfirm } from '@/lib/useConfirm'
import { activatable } from '@/lib/activatable'

// The browser name, from the stored user agent. Rows written before the
// user agent was captured simply show nothing extra.
function browserOf(userAgent) {
  if (!userAgent) return null
  return parseDevice(userAgent).browser
}

// Rendered inside the shared Security panel, so it contributes only its own
// title and body — no .panel wrapper of its own.
// `timezone` is deliberately NOT taken any more. This list formats in the
// reader's own clock, not the account's trading offset - see formatLocal.
export default function SignInHistorySection({ initialEvents }) {
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
      confirmLabel: 'Sign out everywhere',
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
          {/* ONE LIST, TWO LAYOUTS. The table is 760px wide and was
              being rendered inside a 335px phone, scrolling sideways
              with no visible scrollbar on touch - so a phone showed
              whichever slice it happened to be scrolled to, which in
              practice was the date column alone with two empty ones
              beside it. Below 700px the same rows stack instead.
              Driven by CSS rather than by JS so there is one DOM and
              no hydration mismatch: see .signin-table-wrap. */}
          <div className="signin-table-wrap">
          <table className="signin-table">
            <thead><tr><th>Device</th><th>Location</th><th>Date &amp; time</th></tr></thead>
            <tbody>
              {visibleEvents.map((ev) => (
                <tr key={ev.id}>
                  <td data-label="Device">
                    {editingDeviceId === ev.id ? (
                      <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                        {/* No inline fontSize. An inline style beats the stylesheet, so a
                            13px here would keep zooming iOS on focus - in the
                            one component that exists to stop that. Sizing
                            lives in .signin-nickname-input. */}
                        <input type="text" className="signin-nickname-input" value={nicknameInput} onChange={(e) => setNicknameInput(e.target.value)} placeholder={ev.device || 'Unknown device'} autoFocus />
                        <span className="del save-link" {...activatable(() => handleSaveNickname(ev.id))}>Save</span>
                        <span className="del" {...activatable(() => { setEditingDeviceId(null); setNicknameInput('') })}>Cancel</span>
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                        <span className="signin-device">
                          <span className="signin-device-name">
                            {ev.device_nickname || ev.device || 'Unknown device'}
                          </span>
                          {/* The browser, because "iPhone (iOS)" alone
                              cannot be told from another iPhone. */}
                          {browserOf(ev.user_agent) ? (
                            <span className="signin-device-sub">{browserOf(ev.user_agent)}</span>
                          ) : null}
                        </span>
                        <Pencil size={12} className="icon-edit-btn" onClick={() => { setEditingDeviceId(ev.id); setNicknameInput(ev.device_nickname || '') }} />
                      </span>
                    )}
                  </td>
                  <td data-label="Location">
                    <span className="signin-where">{ev.location || 'Unknown location'}</span>
                    {ev.ip_address ? <span className="signin-ip">{ev.ip_address}</span> : null}
                  </td>
                  <td data-label="Date &amp; time">
                    {/* LOCAL time, not the account's trading offset.
                        This account is set to UTC-4 for US session
                        times, which rendered a 07:51 sign-in as
                        "1:51 AM" - defeating the one question this
                        list asks, because the owner cannot recognise
                        their own sign-in. Trade times keep the
                        account offset; a security log belongs in the
                        clock the reader is looking at. */}
                    <span className="signin-when">{formatLocal(ev.created_at)}</span>
                    {relativeTime(ev.created_at) ? (
                      <span className="signin-ago">{relativeTime(ev.created_at)}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {loginEvents.length > 5 && (
            <div className="panel-link-row">
              <span className="panel-link" style={{ cursor: 'pointer' }} {...activatable(() => setShowAllEvents(!showAllEvents))}>
                {showAllEvents ? 'Show fewer' : `Show all ${loginEvents.length} sign-ins`}
              </span>
            </div>
          )}
        </>
      )}

      <div className="submit-row" style={{ justifyContent: 'flex-start', gap: '10px', marginTop: '16px' }}>
        {/* These used to read "Log out of all other devices" and "Log
            out everywhere" - one word apart, side by side, with the
            one that signs you out of the machine you are standing at
            given no extra weight. Both now say what happens to THIS
            device, and the first no longer takes the primary style. */}
        <button type="button" className="btn-accent-outline" onClick={handleSignOutOthers} disabled={sessionBusy}>
          Sign out everywhere else (keeps you signed in here)
        </button>
        <button type="button" className="btn-danger-outline" onClick={handleSignOutEverywhere}>
          Sign out on every device, including this one
        </button>
      </div>
      {sessionMessage && <div className="account-msg account-msg-success">{sessionMessage}</div>}
      {confirmModal}
    </>
  )
}
