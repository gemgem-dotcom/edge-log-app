'use client'

import { useState } from 'react'
import { Copy, Check, Smartphone, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { useConfirm } from '@/lib/useConfirm'
import { activatable } from '@/lib/activatable'
import {
  verifiedFactors, unverifiedFactors, factorLabel,
  suggestFactorName, validateFactorName, isLastFactor,
} from '@/lib/mfaFactors'
import RecoveryCodesSection from '@/components/account/RecoveryCodesSection'

// Rendered inside the shared Security panel, so it contributes only its own
// title and body — no .panel wrapper of its own.
//
// SEVERAL DEVICES, NOT ONE. This used to read `mfaFactors[0]` and show a
// single Enabled/Turn-off row. With one factor that was right; with two it
// was quietly wrong - the second device existed on the account, protected
// nothing the user could see, and could not be removed. The decisions all
// live in lib/mfaFactors.js now, where they can be tested; this file is
// the rendering of them.
export default function TwoFactorSection({ initialFactors, email }) {
  // The whole listFactors payload, not just the totp array: lib/mfaFactors
  // reads `.totp` itself, and keeping the envelope means an unverified
  // factor is still visible to the enrolment guard.
  const [factorData, setFactorData] = useState(
    Array.isArray(initialFactors) ? { totp: initialFactors } : (initialFactors || { totp: [] }),
  )
  const { confirm, modal: confirmModal } = useConfirm()
  const [enrolling, setEnrolling] = useState(false)
  const [enrollQr, setEnrollQr] = useState(null)
  const [enrollSecret, setEnrollSecret] = useState(null)
  const [enrollFactorId, setEnrollFactorId] = useState(null)
  const [deviceName, setDeviceName] = useState('')
  const [verifyCode, setVerifyCode] = useState('')
  const [mfaError, setMfaError] = useState('')
  const [mfaBusy, setMfaBusy] = useState(false)
  const [secretCopied, setSecretCopied] = useState(false)

  const factors = verifiedFactors(factorData)

  async function refreshFactors() {
    const { data } = await supabase.auth.mfa.listFactors()
    setFactorData(data || { totp: [] })
    return data || { totp: [] }
  }

  async function handleEnroll2FA() {
    setMfaError('')
    setMfaBusy(true)

    // An abandoned enrolment leaves an unverified factor behind, which
    // would block a fresh one, so clear those out first. Re-read rather
    // than trusting local state: another tab may have enrolled since this
    // page loaded, and the server is what the enrol call is judged by.
    const current = await refreshFactors()
    for (const stale of unverifiedFactors(current)) {
      await supabase.auth.mfa.unenroll({ factorId: stale.id })
    }
    const fresh = await refreshFactors()

    const friendlyName = suggestFactorName(fresh)
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName })
    setMfaBusy(false)
    if (error) {
      setMfaError("Couldn't start two-factor setup. Please try again.")
      return
    }
    setEnrollFactorId(data.id)
    setEnrollQr(data.totp.qr_code)
    setEnrollSecret(data.totp.secret)
    setDeviceName(friendlyName)
    setEnrolling(true)
  }

  async function handleVerify2FA() {
    setMfaError('')
    // The name is validated before the code, because a name collision is
    // rejected by the server AFTER a correct code has been accepted -
    // which reads as "your code was wrong" when it was not.
    const nameProblem = validateFactorName(deviceName, {
      totp: (factorData?.totp || []).filter((f) => f.id !== enrollFactorId),
    })
    if (nameProblem) {
      setMfaError(nameProblem)
      return
    }
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
    closeEnrolment()
    await refreshFactors()
  }

  function closeEnrolment() {
    setEnrolling(false)
    setEnrollQr(null)
    setEnrollSecret(null)
    setEnrollFactorId(null)
    setVerifyCode('')
    setDeviceName('')
    setMfaError('')
  }

  async function handleCancelEnroll() {
    if (enrollFactorId) {
      await supabase.auth.mfa.unenroll({ factorId: enrollFactorId })
    }
    closeEnrolment()
    await refreshFactors()
  }

  async function handleRemoveFactor(factor) {
    // Removing one of several leaves two-factor authentication on;
    // removing the only one turns the protection off. Same button, two
    // genuinely different consequences, so two different warnings - one
    // wording would either over-warn about a tidy-up or under-warn about
    // a security downgrade.
    const last = isLastFactor(factorData, factor.id)
    const sure = await confirm({
      title: last ? 'Turn Off Two-Factor Authentication' : `Remove ${factorLabel(factor)}`,
      message: last
        ? 'This is your only authenticator. Removing it turns two-factor authentication off, and makes your account easier to access if your password is ever compromised.'
        : `You will no longer be able to use ${factorLabel(factor)} to sign in. Your other authenticators keep working.`,
      confirmLabel: last ? 'Turn off 2FA' : 'Remove device',
      danger: true,
    })
    if (!sure) return
    setMfaBusy(true)
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id })
    setMfaBusy(false)
    if (error) {
      setMfaError("Couldn't remove that device. Please try again.")
      return
    }
    setMfaError('')
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

      {enrolling ? (
        <div className="mfa-enroll-block">
          <p className="onboard-note">Scan this QR code with an authenticator app (Google Authenticator, Authy, 1Password, etc.), then enter the 6-digit code it shows.</p>
          {enrollQr && (
            <div className="mfa-qr-wrap">
              {/* next/image is the wrong tool here and the rule's reasoning
                  does not apply: this is a data: URI generated at runtime by
                  the auth server, so there is no network request to optimize,
                  no remote host to configure, and no LCP cost beyond the
                  bytes already inlined in the response. Routing it through
                  the image optimizer would re-encode a QR code, which is the
                  one kind of image where re-encoding can actually cost you a
                  scan. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={enrollQr} alt="2FA QR code" />
            </div>
          )}
          <div className="mfa-secret-row">
            <span className="trade-id-cell">{enrollSecret}</span>
            <span className="del mfa-copy" {...activatable(handleCopySecret)}>
              {secretCopied ? <><Check size={12} style={{ verticalAlign: '-2px' }} /> copied</> : <><Copy size={12} style={{ verticalAlign: '-2px' }} /> copy</>}
            </span>
          </div>
          {/* Named at enrolment rather than afterwards. With more than one
              authenticator the list is unreadable without names, and the
              moment the user is holding the device is the only moment they
              can say which one it is. */}
          <div className="field wide" style={{ marginTop: '14px' }}>
            <label>Device name</label>
            <input
              type="text" maxLength={60} value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="Personal phone"
            />
          </div>
          <div className="field wide" style={{ marginTop: '14px' }}>
            <label>6-digit code</label>
            <input
              type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} placeholder="123456"
            />
          </div>
          {mfaError && <div className="account-msg account-msg-error" style={{ marginTop: '10px' }}>{mfaError}</div>}
          <div className="submit-row" style={{ gap: '10px' }}>
            <button type="button" className="btn-danger-outline" onClick={handleCancelEnroll}>Cancel</button>
            <button type="button" onClick={handleVerify2FA} disabled={mfaBusy}>{mfaBusy ? 'Verifying...' : 'Verify & enable'}</button>
          </div>
        </div>
      ) : factors.length > 0 ? (
        <>
          <div className="mfa-status-row">
            <div>
              <div className="mfa-status-enabled">Enabled</div>
              <div className="danger-row-note">
                {factors.length === 1
                  ? 'Your account requires a code from your authenticator app at login.'
                  : `Any of these ${factors.length} devices can provide your login code.`}
              </div>
            </div>
            <button onClick={handleEnroll2FA} disabled={mfaBusy}>
              {mfaBusy ? 'Starting...' : 'Add device'}
            </button>
          </div>

          <ul className="mfa-factor-list">
            {factors.map((factor) => (
              <li className="mfa-factor-row" key={factor.id}>
                <span className="mfa-factor-icon" aria-hidden="true"><Smartphone size={15} /></span>
                <span className="mfa-factor-name">{factorLabel(factor)}</span>
                <button
                  type="button"
                  className="mfa-factor-remove"
                  onClick={() => handleRemoveFactor(factor)}
                  disabled={mfaBusy}
                  aria-label={`Remove ${factorLabel(factor)}`}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
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

      {/* Owned here rather than by the account page because this
          component holds the factor state, and whether recovery codes
          are relevant at all depends on it. Hidden entirely during
          enrolment: the user is mid-task and a second call to action
          would compete with the one they are already doing. */}
      {!enrolling && (
        <div className="mfa-recovery-block">
          <RecoveryCodesSection twoFactorOn={factors.length > 0} email={email} />
        </div>
      )}

      {confirmModal}
    </>
  )
}
