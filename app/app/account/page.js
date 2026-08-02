'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff, ArrowLeft, LogOut, Shield, Monitor, Sun, Moon, Download, Copy, Check } from 'lucide-react'
import { supabase } from '../../../lib/supabaseClient'

const UTC_OFFSETS = [-12, -11, -10, -9.5, -9, -8, -7, -6, -5, -4.5, -4, -3.5, -3, -2, -1, 0, 1, 2, 3, 3.5, 4, 4.5, 5, 5.5, 5.75, 6, 6.5, 7, 8, 8.75, 9, 9.5, 10, 10.5, 11, 12, 12.75, 13, 14].map((h) => {
  const sign = h >= 0 ? '+' : '-'
  const abs = Math.abs(h)
  const hh = Math.floor(abs)
  const mm = Math.round((abs - hh) * 60)
  const label = `UTC${sign}${hh}${mm ? ':' + String(mm).padStart(2, '0') : ''}`
  return { value: String(h), label }
})

function formatInTz(isoString, tz) {
  const offsetHours = parseFloat(tz)
  const instant = new Date(isoString)
  const shifted = new Date(instant.getTime() + (isNaN(offsetHours) ? 0 : offsetHours) * 3600000)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const datePart = `${months[shifted.getUTCMonth()]} ${shifted.getUTCDate()}, ${shifted.getUTCFullYear()}`
  let hh = shifted.getUTCHours()
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0')
  const ampm = hh >= 12 ? 'PM' : 'AM'
  hh = hh % 12
  if (hh === 0) hh = 12
  return `${datePart}, ${hh}:${mm} ${ampm}`
}

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

  // Two-factor authentication
  const [mfaFactors, setMfaFactors] = useState([])
  const [enrolling, setEnrolling] = useState(false)
  const [enrollQr, setEnrollQr] = useState(null)
  const [enrollSecret, setEnrollSecret] = useState(null)
  const [enrollFactorId, setEnrollFactorId] = useState(null)
  const [verifyCode, setVerifyCode] = useState('')
  const [mfaError, setMfaError] = useState('')
  const [mfaBusy, setMfaBusy] = useState(false)
  const [secretCopied, setSecretCopied] = useState(false)

  // Sign-in history / sessions
  const [loginEvents, setLoginEvents] = useState([])
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessionMessage, setSessionMessage] = useState('')

  // Preferences
  const [theme, setTheme] = useState('dark')
  const [timezone, setTimezone] = useState('0')

  // Data export
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

useEffect(() => {
  loadData()
}, [])

async function loadData() {
  const { data: { user } } = await supabase.auth.getUser()
  setEmail(user.email)
  setFullName(user.user_metadata && user.user_metadata.full_name ? user.user_metadata.full_name : '')
const savedTz = user.user_metadata?.timezone
  if (savedTz !== undefined && savedTz !== null && UTC_OFFSETS.some((o) => o.value === String(savedTz))) {
    setTimezone(String(savedTz))
  } else {
    const browserOffset = -(new Date().getTimezoneOffset()) / 60
    const nearest = UTC_OFFSETS.reduce((best, o) =>
      Math.abs(parseFloat(o.value) - browserOffset) < Math.abs(parseFloat(best.value) - browserOffset) ? o : best
      )
    setTimezone(nearest.value)
  }

  // Theme — read from localStorage (matches the inline script in layout.js
  // that prevents a flash of the wrong theme on page load).
  const storedTheme = typeof window !== 'undefined' ? localStorage.getItem('edgelog-theme') : null
  setTheme(storedTheme || 'dark')

  const { data: factorsData } = await supabase.auth.mfa.listFactors()
  setMfaFactors(factorsData?.totp || [])

  const { data: events } = await supabase
    .from('login_events')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(10)
  setLoginEvents(events || [])

  setLoading(false)
}

async function handleNameBlur() {
  await supabase.auth.updateUser({ data: { full_name: fullName.trim() } })
}

async function handleLogout() {
  await supabase.auth.signOut()
  router.push('/login')
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

async function handleEnroll2FA() {
  setMfaError('')
  setMfaBusy(true)
  const { data: existing } = await supabase.auth.mfa.listFactors()
    const stale = (existing?.totp || []).filter((f) => f.status !== 'verified')
      for (const f of stale) {
        await supabase.auth.mfa.unenroll({ factorId: f.id })
      }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
  setMfaBusy(false)
  if (error) {
    setMfaError(error.message)
    return
  }
  setEnrollFactorId(data.id)
  setEnrollQr(data.totp.qr_code)
  setEnrollSecret(data.totp.secret)
  setEnrolling(true)
}

async function handleVerify2FA() {
  setMfaError('')
  if (!verifyCode.trim()) {
    setMfaError('Enter the 6-digit code from your authenticator app.')
    return
  }
  setMfaBusy(true)
  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: enrollFactorId })
  if (challengeError) {
    setMfaError(challengeError.message)
    setMfaBusy(false)
    return
  }
  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId: enrollFactorId,
    challengeId: challenge.id,
    code: verifyCode.trim(),
  })
  setMfaBusy(false)
  if (verifyError) {
    setMfaError('Incorrect code — try again.')
    return
  }
  setEnrolling(false)
  setEnrollQr(null)
  setEnrollSecret(null)
  setVerifyCode('')
  const { data: factorsData } = await supabase.auth.mfa.listFactors()
  setMfaFactors(factorsData?.totp || [])
}

async function handleCancelEnroll() {
  if (enrollFactorId) {
    await supabase.auth.mfa.unenroll({ factorId: enrollFactorId })
  }
  setEnrolling(false)
  setEnrollQr(null)
  setEnrollSecret(null)
  setVerifyCode('')
  setMfaError('')
}

async function handleDisable2FA(factorId) {
  const sure = confirm('Turn off two-factor authentication? This makes your account easier to access if your password is ever compromised.')
  if (!sure) return
  setMfaBusy(true)
  const { error } = await supabase.auth.mfa.unenroll({ factorId })
  setMfaBusy(false)
  if (error) {
    setMfaError(error.message)
    return
  }
  const { data: factorsData } = await supabase.auth.mfa.listFactors()
  setMfaFactors(factorsData?.totp || [])
}

function handleCopySecret() {
  navigator.clipboard.writeText(enrollSecret)
  setSecretCopied(true)
  setTimeout(() => setSecretCopied(false), 2000)
}

async function handleSignOutOthers() {
  setSessionMessage('')
  setSessionBusy(true)
  const { error } = await supabase.auth.signOut({ scope: 'others' })
  setSessionBusy(false)
  setSessionMessage(error ? error.message : 'Signed out of all other devices.')
}

async function handleSignOutEverywhere() {
  const sure = confirm('Sign out of every device, including this one? You will need to log in again.')
  if (!sure) return
  await supabase.auth.signOut({ scope: 'global' })
  router.push('/login')
}

function handleThemeChange(newTheme) {
  setTheme(newTheme)
  localStorage.setItem('edgelog-theme', newTheme)
  document.documentElement.setAttribute('data-theme', newTheme)
}

async function handleTimezoneChange(newTz) {
  setTimezone(newTz)
  await supabase.auth.updateUser({ data: { timezone: newTz } })
}

async function handleDownloadCsv() {
  setExportError('')
  setExporting(true)
  const { data: { user } } = await supabase.auth.getUser()

  const { data: trades, error } = await supabase
    .from('trades')
    .select('*, instruments(symbol), strategies(name)')
    .eq('user_id', user.id)
    .order('trade_date', { ascending: true })

  setExporting(false)
  if (error) {
    setExportError(error.message)
    return
  }
  if (!trades || trades.length === 0) {
    setExportError('No trades logged yet — nothing to export.')
    return
  }

  const headers = [
    'instrument', 'strategy', 'trade_date', 'trade_time', 'direction', 'entry', 'stop',
    'target', 'exit_price', 'exit_time', 'multi_exit', 'r_multiple', 'in_plan',
    'contracts', 'reasoning',
  ]
  const rows = trades.map((t) => [
    t.instruments?.symbol || '', t.strategies?.name || 'Unclassified', t.trade_date, t.trade_time,
    t.direction, t.entry, t.stop, t.target ?? '', t.exit_price ?? '', t.exit_time ?? '',
    t.multi_exit, t.r_multiple, t.in_plan, t.contracts ?? '',
    (t.reasoning || '').replace(/"/g, '""'),
  ])
  const csv = [headers.join(','), ...rows.map((r) => r.map((v) => `"${v}"`).join(','))].join('\n')

  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `edgelog-journal-${new Date().toISOString().split('T')[0]}.csv`
  a.click()
  URL.revokeObjectURL(url)
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
  <div className="account-topbar-left">
  <div className="shell-logo">Edge<span>Log</span></div>
  <a href="/app" className="back-btn"><ArrowLeft size={16} /> Back to dashboard</a>
  </div>
  <button className="back-btn" onClick={handleLogout}><LogOut size={16} /> Log out</button>
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

<div className="section-heading">Security</div>
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

<div className="panel">
  <div className="panel-title"><Shield size={15} style={{ marginRight: '8px', verticalAlign: '-3px' }} />Two-factor authentication</div>
  {mfaFactors.length > 0 && !enrolling ? (
    <div className="mfa-status-row">
      <div>
        <div className="mfa-status-enabled">Enabled</div>
        <div className="danger-row-note">Your account requires a code from your authenticator app at login.</div>
      </div>
      <button className="btn-danger-outline" onClick={() => handleDisable2FA(mfaFactors[0].id)} disabled={mfaBusy}>
        {mfaBusy ? 'Working…' : 'Turn off 2FA'}
      </button>
    </div>
  ) : enrolling ? (
    <div className="mfa-enroll-block">
      <p className="onboard-note">Scan this QR code with an authenticator app (Google Authenticator, Authy, 1Password, etc.), then enter the 6-digit code it shows.</p>
      {enrollQr && (
        <div className="mfa-qr-wrap">
        <img src={enrollQr} alt="2FA QR code" />
        </div>
      )}
      <div className="mfa-secret-row">
        <span className="trade-id-cell">{enrollSecret}</span>
          {secretCopied ? <><Check size={12} style={{ verticalAlign: '-2px' }} /> copied</> : <><Copy size={12} style={{ verticalAlign: '-2px' }} /> copy</>}
        </span>
      </div>
      <div className="field wide" style={{ marginTop: '14px' }}>
        <label>6-digit code</label>
        <input type="text" maxLength={6} value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} placeholder="123456" />
      </div>
      {mfaError && <div className="account-msg account-msg-error" style={{ marginTop: '10px' }}>{mfaError}</div>}
      <div className="submit-row" style={{ gap: '10px' }}>
        <button type="button" className="btn-danger-outline" onClick={handleCancelEnroll}>Cancel</button>
        <button type="button" onClick={handleVerify2FA} disabled={mfaBusy}>{mfaBusy ? 'Verifying…' : 'Verify & enable'}</button>
      </div>
    </div>
  ) : (
    <div className="mfa-status-row">
      <div>
        <div className="danger-row-title">Not enabled</div>
        <div className="danger-row-note">Add an extra layer of security beyond your password.</div>
      </div>
      <button onClick={handleEnroll2FA} disabled={mfaBusy}>{mfaBusy ? 'Starting…' : 'Set up 2FA'}</button>
    </div>
  )}
  {mfaError && !enrolling && <div className="account-msg account-msg-error" style={{ marginTop: '10px' }}>{mfaError}</div>}
</div>

<div className="panel">
  <div className="panel-title"><Monitor size={15} style={{ marginRight: '8px', verticalAlign: '-3px' }} />Sessions</div>
  <div className="submit-row" style={{ justifyContent: 'flex-start', gap: '10px', marginBottom: '16px' }}>
    <button type="button" onClick={handleSignOutOthers} disabled={sessionBusy}>Log out of all other devices</button>
    <button type="button" className="btn-danger-outline" onClick={handleSignOutEverywhere}>Log out everywhere</button>
  </div>
  {sessionMessage && <div className="account-msg account-msg-success" style={{ marginBottom: '14px' }}>{sessionMessage}</div>}
  <div className="detail-sublabel" style={{ marginBottom: '8px' }}>Recent sign-ins</div>
  {loginEvents.length === 0 ? (
    <div className="empty" style={{ padding: '14px' }}>No sign-in history yet.</div>
  ) : (
    <table>
      <thead><tr><th>When</th><th>Browser / device</th></tr></thead>
      <tbody>
        {loginEvents.map((ev) => (
          <tr key={ev.id}>
            <td>{formatInTz(ev.created_at, timezone)}</td>
            <td className="tag-cell">{ev.user_agent || 'Unknown'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )}
  <p className="account-fine-print">
    This list shows recent sign-ins to your account, not currently-open sessions on other devices — Supabase doesn't expose
    live per-device session data. "Log out everywhere" is real and immediate; the history above is for your awareness.
  </p>
</div>

<div className="section-heading" style={{ marginTop: '8px' }}>Preferences</div>
<div className="panel">
  <div className="field wide">
    <label>Theme</label>
    <div className="dir-toggle">
      <div className={`dir-btn ${theme === 'dark' ? 'active-long' : ''}`} onClick={() => handleThemeChange('dark')}>
        <Moon size={13} style={{ marginRight: '6px', verticalAlign: '-2px' }} />Dark
      </div>
      <div className={`dir-btn ${theme === 'light' ? 'active-long' : ''}`} onClick={() => handleThemeChange('light')}>
        <Sun size={13} style={{ marginRight: '6px', verticalAlign: '-2px' }} />Light
      </div>
    </div>
  </div>
  <div className="field wide" style={{ marginTop: '14px' }}>
    <label>Timezone</label>
<select value={timezone} onChange={(e) => handleTimezoneChange(e.target.value)}>
{UTC_OFFSETS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                 </select>
                 </div>
                 <p className="account-fine-print">
                 Set this to the UTC offset your trade times are logged in. It keeps the sign-in times above consistent with the
    timezone you use for your trade log, rather than defaulting to your browser's local time.
  </p>
</div>

<div className="section-heading" style={{ marginTop: '8px' }}>Data</div>
<div className="panel">
  <div className="danger-row">
    <div>
      <div className="danger-row-title">Download my journal</div>
      <div className="danger-row-note">Every trade you've logged, across every instrument and strategy, as a CSV file.</div>
    </div>
    <button onClick={handleDownloadCsv} disabled={exporting}>
      <Download size={14} style={{ marginRight: '6px', verticalAlign: '-2px' }} />{exporting ? 'Preparing…' : 'Download CSV'}
    </button>
  </div>
  {exportError && <div className="account-msg account-msg-error" style={{ marginTop: '14px' }}>{exportError}</div>}
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
