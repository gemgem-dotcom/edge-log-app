'use client'

import { useState, useEffect, useCallback } from 'react'
import { MonitorSmartphone, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { useConfirm } from '@/lib/useConfirm'
import { isMockDbEnabled } from '@/lib/mockMode'

// The browsers this account has told EdgeLog not to challenge.
//
// "Devices", not "computers", in every string a user reads. The list
// genuinely holds phones and tablets - lib/deviceLabel.js labels
// iPhone, iPad and Android - so the old wording told someone their
// phone was a computer, and the icon beside each row has always been
// a phone-and-monitor pair.
//
// It renders as a SUBSECTION of two-factor authentication, not a peer
// of it: .panel-subtitle rather than .panel-title, inside the indented
// .trusted-device-block its parent provides. Remembering a browser is
// a setting ON two-factor authentication - it has no meaning at all
// with 2FA off, which is why the parent does not render this at all
// then - and two identical uppercase labels in one card said the
// opposite.
//
// WHY THIS SCREEN HAS TO EXIST. A trusted-device cookie skips the
// second factor for thirty days, which makes it as powerful as the
// factor itself for anything EdgeLog protects. Granting that from a
// checkbox on the login page while giving no way to see or undo it
// would mean a browser ticked once on a shared machine keeps working
// for a month with the owner having no way to find out, let alone
// stop it. The list is the other half of the feature, not a nicety.
//
// It reads through a server route rather than querying Supabase
// directly like the rest of the app does. mfa_trusted_device has row
// level security on with no policies - deliberately, since a client
// that could insert a row could mint itself a permanent skip - so
// there is nothing for a browser client to read.
// Only ever reached in mock mode (see load()). One row of each state
// the list can be in - plenty of time left, nearly expired, and
// expired - because those are the three that look different.
const MOCK_DEVICES = [
  { id: 'mock-1', label: 'Mac (macOS)', valid: true, daysLeft: 28, note: "Won't ask for a code for 28 more days" },
  { id: 'mock-2', label: 'iPhone (iOS)', valid: true, daysLeft: 1, note: "Won't ask for a code for 1 more day" },
  { id: 'mock-3', label: 'Windows PC (Windows)', valid: false, daysLeft: 0, note: 'Expired - this device will be asked for a code' },
]

export default function TrustedDevicesSection({ twoFactorOn }) {
  const { confirm, modal: confirmModal } = useConfirm()
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (alive = () => true) => {
    // In mock mode this list has nowhere real to come from:
    // /api/trusted-device authenticates for real and refuses the
    // mock's fake token, so every account page load printed a 401 in
    // the console and the section rendered an error. That is noise in
    // the one environment this repo uses to check UI work, and the
    // regression fingerprint caught it as a change from a clean
    // console - which is exactly what that check is for. Representative
    // rows instead, the same way MOCK_FACTORS stands in for real
    // factors.
    if (isMockDbEnabled()) {
      if (alive()) { setDevices(MOCK_DEVICES); setLoading(false) }
      return
    }
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { if (alive()) setLoading(false); return }
      const res = await fetch('/api/trusted-device', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!alive()) return
      if (!res.ok) { setError("Couldn't load your list of devices."); setLoading(false); return }
      const data = await res.json()
      setDevices(data.devices || [])
      setError('')
    } catch {
      if (alive()) setError("Couldn't load your list of devices.")
    } finally {
      if (alive()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    load(() => mounted)
    return () => { mounted = false }
  }, [load])

  async function forget(device) {
    const sure = await confirm({
      title: `Forget ${device.label}?`,
      message: 'That device will be asked for a code the next time it signs in.',
      confirmLabel: 'Ask it for a code again',
      danger: true,
    })
    if (!sure) return
    await send(`/api/trusted-device?id=${encodeURIComponent(device.id)}`)
  }

  async function forgetAll() {
    // The button someone reaches for after losing a laptop, so the
    // wording names that situation rather than describing the
    // mechanism - "revoke all trusted device tokens" is not what the
    // person having that afternoon is searching for.
    const sure = await confirm({
      title: 'Forget every device',
      message: 'Every device, including this one, will be asked for a code at the next sign-in. Do this if a device has been lost or stolen.',
      confirmLabel: 'Forget all',
      danger: true,
    })
    if (!sure) return
    await send('/api/trusted-device?all=1')
  }

  async function send(url) {
    setBusy(true)
    setError('')
    if (isMockDbEnabled()) {
      // Mirror the real outcome locally so the remove flows can be
      // driven and seen, rather than appearing to do nothing.
      const id = new URL(url, 'http://x').searchParams.get('id')
      setDevices((d) => (new URL(url, 'http://x').searchParams.get('all') === '1' ? [] : d.filter((x) => x.id !== id)))
      setBusy(false)
      return
    }
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session?.access_token}` },
      })
      if (!res.ok) setError("Couldn't update your list of devices. Please try again.")
    } catch {
      setError("Couldn't update your list of devices. Please try again.")
    }
    setBusy(false)
    await load()
  }

  // Nothing to say when 2FA is off: there is no challenge to skip, so
  // a section about skipping one is just a puzzle.
  if (!twoFactorOn) return null

  return (
    <>
      <div className="panel-subtitle">Devices that don&apos;t ask for a code</div>
      <div className="mfa-status-row">
        <div>
          {/* Not .danger-row-title (14.5px bold) as it was: with the
              subsection heading directly above it, a line heavier than
              its own heading inverted the hierarchy, and the two said
              nearly the same words. A quiet count under the heading
              reads as the heading's answer rather than as a second
              title. */}
          <div className="trusted-device-count">
            {loading
              ? 'Checking...'
              : devices.length === 0
                ? 'None'
                : `${devices.length} device${devices.length === 1 ? '' : 's'} won't be asked for a code`}
          </div>
          {/* The "how did these get here" sentence used to show only
              when the list was EMPTY - that is, only when nobody
              needed it. It is now always said, because the section
              otherwise reads as something the app did rather than
              something the user chose. */}
          <div className="danger-row-note">
            These are devices where you ticked &ldquo;skip the code&rdquo; when signing in.
            {devices.length > 0 && ' Each can sign in with your password alone until the date shown.'}
          </div>
        </div>
        {devices.length > 0 && (
          <button type="button" className="btn-danger-outline" onClick={forgetAll} disabled={busy}>
            {busy ? 'Working...' : 'Forget all'}
          </button>
        )}
      </div>

      {devices.length > 0 && (
        <ul className="trusted-device-list">
          {devices.map((d) => (
            <li className={`trusted-device-row${d.valid ? '' : ' is-expired'}`} key={d.id}>
              <span className="trusted-device-icon" aria-hidden="true"><MonitorSmartphone size={15} /></span>
              <span className="trusted-device-text">
                <span className="trusted-device-name">{d.label}</span>
                <span className="trusted-device-note">{d.note}</span>
              </span>
              <button
                type="button"
                className="trusted-device-forget"
                onClick={() => forget(d)}
                disabled={busy}
                aria-label={`Forget ${d.label}`}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <div className="account-msg account-msg-error" style={{ marginTop: '10px' }}>{error}</div>}
      {confirmModal}
    </>
  )
}
