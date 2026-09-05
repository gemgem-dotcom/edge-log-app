'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { useConfirm } from '@/lib/useConfirm'

// Rendered inside the shared Security panel, so it contributes only its own
// title and body — no .panel wrapper of its own.
export default function TwoFactorSection({ initialFactors }) {
  const [mfaFactors, setMfaFactors] = useState(initialFactors)
  const { confirm, modal: confirmModal } = useConfirm()
  const [enrolling, setEnrolling] = useState(false)
  const [enrollQr, setEnrollQr] = useState(null)
  const [enrollSecret, setEnrollSecret] = useState(null)
  const [enrollFactorId, setEnrollFactorId] = useState(null)
  const [verifyCode, setVerifyCode] = useState('')
  const [mfaError, setMfaError] = useState('')
  const [mfaBusy, setMfaBusy] = useState(false)
  const [secretCopied, setSecretCopied] = useState(false)

  async function refreshFactors() {
    const { data } = await supabase.auth.mfa.listFactors()
    setMfaFactors(data?.totp || [])
  }

  async function handleEnroll2FA() {
    setMfaError('')
    setMfaBusy(true)
    // An abandoned enrolment leaves an unverified factor behind, which would
    // block a fresh one, so clear those out first.
    const { data: existing } = await supabase.auth.mfa.listFactors()
    const stale = (existing?.totp || []).filter((f) => f.status !== 'verified')
    for (const f of stale) {
      await supabase.auth.mfa.unenroll({ factorId: f.id })
    }
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
    setMfaBusy(false)
    if (error) {
      setMfaError("Couldn't start two-factor setup. Please try again.")
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
      setMfaError("Couldn't verify that code. Please try again.")
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
      setMfaError('Incorrect code - try again.')
      return
    }
    setEnrolling(false)
    setEnrollQr(null)
    setEnrollSecret(null)
    setVerifyCode('')
    await refreshFactors()
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
    const sure = await confirm({
      title: 'Turn Off Two-Factor Authentication',
      message: 'This makes your account easier to access if your password is ever compromised.',
      confirmLabel: 'Turn off 2FA',
      danger: true,
    })
    if (!sure) return
    setMfaBusy(true)
    const { error } = await supabase.auth.mfa.unenroll({ factorId })
    setMfaBusy(false)
    if (error) {
      setMfaError("Couldn't turn off two-factor authentication. Please try again.")
      return
    }
    await refreshFactors()
  }

  function handleCopySecret() {
    navigator.clipboard.writeText(enrollSecret)
    setSecretCopied(true)
    setTimeout(() => setSecretCopied(false), 2000)
  }

  return (
    <>
      <div className="panel-title">Two-factor authentication</div>
      {mfaFactors.length > 0 && !enrolling ? (
        <div className="mfa-status-row">
          <div>
            <div className="mfa-status-enabled">Enabled</div>
            <div className="danger-row-note">Your account requires a code from your authenticator app at login.</div>
          </div>
          <button className="btn-danger-outline" onClick={() => handleDisable2FA(mfaFactors[0].id)} disabled={mfaBusy}>
            {mfaBusy ? 'Working...' : 'Turn off 2FA'}
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
            <button type="button" className="del" onClick={handleCopySecret}>
              {secretCopied ? <><Check size={12} style={{ verticalAlign: '-2px' }} /> copied</> : <><Copy size={12} style={{ verticalAlign: '-2px' }} /> copy</>}
            </button>
          </div>
          <div className="field wide" style={{ marginTop: '14px' }}>
            <label>6-digit code</label>
            <input type="text" maxLength={6} value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} placeholder="123456" />
          </div>
          {mfaError && <div className="account-msg account-msg-error" style={{ marginTop: '10px' }}>{mfaError}</div>}
          <div className="submit-row" style={{ gap: '10px' }}>
            <button type="button" className="btn-danger-outline" onClick={handleCancelEnroll}>Cancel</button>
            <button type="button" onClick={handleVerify2FA} disabled={mfaBusy}>{mfaBusy ? 'Verifying...' : 'Verify & enable'}</button>
          </div>
        </div>
      ) : (
        <div className="mfa-status-row">
          <div>
            <div className="danger-row-title">Not enabled</div>
            <div className="danger-row-note">Add an extra layer of security beyond your password.</div>
          </div>
          <button onClick={handleEnroll2FA} disabled={mfaBusy}>{mfaBusy ? 'Starting...' : 'Set up 2FA'}</button>
        </div>
      )}
      {mfaError && !enrolling && <div className="account-msg account-msg-error" style={{ marginTop: '10px' }}>{mfaError}</div>}
      {confirmModal}
    </>
  )
}
