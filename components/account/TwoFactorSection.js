'use client'

import { useState } from 'react'
import { Copy, Check, Smartphone, Trash2 } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import TrustedDevicesSection from '@/components/account/TrustedDevicesSection'
import { useConfirm } from '@/lib/useConfirm'
import { checkAttemptAllowed, recordAttempt } from '@/lib/mfaAttemptClient'
import {
  verifiedFactors, unverifiedFactors, factorLabel,
  suggestFactorName, validateFactorName, isLastFactor,
} from '@/lib/mfaFactors'

// Rendered inside the shared Security panel, so it contributes only its own
// title and body — no .panel wrapper of its own.
//
// SEVERAL DEVICES, NOT ONE. This used to read `mfaFactors[0]` and show a
// single Enabled/Turn-off row. With one factor that was right; with two it
// was quietly wrong - the second device existed on the account, protected
// nothing the user could see, and could not be removed. The decisions all
// live in lib/mfaFactors.js now, where they can be tested; this file is
// the rendering of them.
export default function TwoFactorSection({ initialFactors }) {
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

    // The same limit as the login page, and for a less obvious reason:
    // this screen is reachable by anyone holding an unattended signed-in
    // browser, and unlimited guesses here would let them enrol their own
    // authenticator onto somebody else's account.
    const gate = await checkAttemptAllowed('totp')
    if (!gate.allowed) {
      setMfaError(gate.message)
      setMfaBusy(false)
      return
    }

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
    const after = await recordAttempt('totp', !verifyError)
    setMfaBusy(false)
    if (verifyError) {
      setMfaError(after.message || "That code didn't work. Codes only last 30 seconds - wait for a fresh number in your app and type that one.")
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
    // Named for the consequence rather than the mechanism. "Unenroll
    // your TOTP factor" is accurate and tells a person nothing about
    // what is about to happen to them.
    const sure = await confirm({
      title: last ? 'Stop asking for a sign-in code?' : `Remove ${factorLabel(factor)}`,
      message: last
        ? 'This is your only phone. Remove it and EdgeLog will stop asking for a code when you sign in, so your password alone would let anyone in.'
        : `${factorLabel(factor)} will no longer give you sign-in codes. Your other phone still will.`,
      confirmLabel: last ? 'Stop asking for codes' : 'Remove it',
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
          {/* Two routes, because the single "scan this QR code"
              instruction is physically impossible when this page is
              open on the very phone being set up - which on mobile is
              the likeliest case, and left people stuck with no way
              forward. */}
          <ol className="mfa-steps">
            <li>
              <strong>Get a code app on your phone.</strong> If you don&apos;t have one,
              install Google Authenticator, Authy or 1Password - they&apos;re free.
            </li>
            <li>
              <strong>On a computer:</strong> open the app on your phone, tap +, and
              point the camera at the square below.<br />
              <strong>On this phone:</strong> tap <em>copy</em> under the square, then in the
              app tap + and choose &ldquo;enter a setup key&rdquo;.
            </li>
            <li>
              <strong>Type the 6-digit number the app shows.</strong> It changes every
              30 seconds, so use whatever it says right now.
            </li>
          </ol>
          {enrollQr && (
            <div className="mfa-qr-wrap">
              {/* next/image is the wrong tool here and the rule's
                  reasoning does not apply: this is a data: URI
                  generated at runtime by the auth server, so there is
                  no network request to optimize, no remote host to
                  configure, and no LCP cost beyond the bytes already
                  inlined in the response. Routing it through the image
                  optimizer would also re-encode a QR code, which is the
                  one kind of image where re-encoding can cost you a
                  scan. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={enrollQr} alt="2FA QR code" />
            </div>
          )}
          {/* Labelled. It used to be an unexplained grey string, which
              is the one thing a person setting up on their phone
              actually needs. */}
          <div className="mfa-secret-label">Setup key &mdash; use this instead of the square</div>
          <div className="mfa-secret-row">
            <span className="trade-id-cell">{enrollSecret}</span>
            <button type="button" className="mfa-copy-btn" onClick={handleCopySecret}>
              {secretCopied
                ? <><Check size={14} /> copied</>
                : <><Copy size={14} /> copy</>}
            </button>
          </div>

          {/* Said at the moment they are paying attention, because the
              consequence only becomes visible eight months later when
              the phone is gone. */}
          <div className="mfa-no-codes-note">
            <strong>Keep this phone safe.</strong> EdgeLog has no backup codes. If you
            lose it, the only way back in is to reset your password by email &mdash;
            which switches the sign-in code off, and you set it up again on a new phone.
          </div>
          {/* Named at enrolment rather than afterwards. With more than one
              authenticator the list is unreadable without names, and the
              moment the user is holding the device is the only moment they
              can say which one it is. */}
          <div className="field wide" style={{ marginTop: '14px' }}>
            {/* Short, because the form styling uppercases labels and a
                full question in capitals shouts. The question itself
                moved into the hint below. */}
            <label>Name this phone</label>
            <input
              type="text" maxLength={60} value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="My phone"
            />
            <div className="field-hint">What should we call it? Just so you can tell it apart if you add a second one.</div>
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

      {/* Owned here because whether remembered browsers mean anything
          at all depends on the factor state this component holds.
          Hidden during enrolment: the user is mid-task and a second
          call to action would compete with the one they are doing. */}
      {!enrolling && factors.length > 0 && (
        <div className="trusted-device-block">
          <TrustedDevicesSection twoFactorOn />
        </div>
      )}

      {confirmModal}
    </>
  )
}
