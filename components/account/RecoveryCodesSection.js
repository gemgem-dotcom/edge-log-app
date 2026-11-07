'use client'

import { useState, useEffect, useCallback } from 'react'
import { Copy, Check, Download, KeyRound } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { useConfirm } from '@/lib/useConfirm'
import {
  getRecoveryStatus, generateRecoveryCodes, regenerateRecoveryCodes,
  recoveryAdvice, recoveryCodesFileBody, recoveryCodesFileName,
} from '@/lib/mfaRecovery'

// Recovery codes, rendered under the two-factor section it belongs to.
//
// THE CODES ARE SHOWN EXACTLY ONCE. The server returns them from
// generate() and cannot return them again - there is no "show me my
// codes" call, by design, because storing them retrievably would make
// them no safer than a password hint. So this screen is the user's only
// chance to keep them, and the whole layout exists to make that chance
// hard to waste: download and copy are both one click, and the panel
// will not collapse back to a summary until the user says they have
// them.
export default function RecoveryCodesSection({ twoFactorOn, email }) {
  const { confirm, modal: confirmModal } = useConfirm()
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [codes, setCodes] = useState(null)      // non-null only on the show-once screen
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [downloaded, setDownloaded] = useState(false)

  // `alive` rather than a bare await-then-setState. This block unmounts
  // the moment the user starts enrolling a new authenticator, which is a
  // realistic thing to do while the status request is still in flight,
  // and a setState after that point is a warning in development and a
  // leak in principle.
  const load = useCallback(async (alive = () => true) => {
    const { status: s, error: e } = await getRecoveryStatus(supabase)
    if (!alive()) return
    setStatus(s)
    setError(e ? "Couldn't check your recovery codes." : '')
    setLoading(false)
  }, [])

  useEffect(() => {
    let mounted = true
    load(() => mounted)
    return () => { mounted = false }
  }, [load])

  async function handleGenerate() {
    setError('')
    setBusy(true)
    const { data, error: genError } = await generateRecoveryCodes(supabase)
    setBusy(false)
    if (genError || !data?.codes?.length) {
      setError("Couldn't create recovery codes. Please try again.")
      return
    }
    setCodes(data.codes)
    setCopied(false)
    setDownloaded(false)
  }

  async function handleRegenerate() {
    // Regenerating is destructive in a way that is easy to miss: the
    // codes already printed out and filed away stop working the instant
    // a new set is issued. Someone doing this to "get a fresh copy"
    // because they mislaid the old one needs to know the old one is now
    // worthless rather than merely lost.
    const sure = await confirm({
      title: 'Replace your recovery codes',
      message: 'Your current codes stop working immediately. Any copy you have saved or printed becomes useless, and you will need to store the new set.',
      confirmLabel: 'Replace codes',
      danger: true,
    })
    if (!sure) return
    setError('')
    setBusy(true)
    const { data, error: regenError } = await regenerateRecoveryCodes(supabase)
    setBusy(false)
    if (regenError || !data?.codes?.length) {
      setError("Couldn't replace your recovery codes. Please try again.")
      return
    }
    setCodes(data.codes)
    setCopied(false)
    setDownloaded(false)
  }

  function handleCopy() {
    navigator.clipboard.writeText((codes || []).join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // A real file rather than "select this text and save it somewhere".
  // The person who most needs recovery codes is the one who will not do
  // a multi-step manual save, and an object URL costs nothing.
  function handleDownload() {
    const blob = new Blob([recoveryCodesFileBody(codes, { email })], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = recoveryCodesFileName()
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    // Revoked on the next tick rather than immediately: Safari has been
    // known to cancel an in-flight download when the URL is released in
    // the same frame as the click.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setDownloaded(true)
  }

  async function handleDone() {
    // Nagging once is worth it. Clicking past this screen without
    // keeping the codes is silent, irreversible, and the user will not
    // discover it until the day they are locked out.
    if (!copied && !downloaded) {
      const sure = await confirm({
        title: 'Save your codes first',
        message: "You haven't copied or downloaded these codes. They cannot be shown again - if you lose access to your authenticator and don't have them, you will lose access to this account.",
        confirmLabel: 'I have saved them',
        danger: true,
      })
      if (!sure) return
    }
    setCodes(null)
    await load()
  }

  const advice = recoveryAdvice(status, { twoFactorOn })

  // The show-once screen takes over the section entirely - nothing else
  // should compete with it while the codes are on screen.
  if (codes) {
    return (
      <>
        <div className="panel-title">Recovery codes</div>
        <div className="mfa-recovery-reveal">
          <p className="onboard-note">
            Save these now. Each one gets you in once if you lose your authenticator,
            and <strong>they cannot be shown again.</strong>
          </p>
          <ul className="mfa-code-grid">
            {codes.map((c) => <li key={c}><code>{c}</code></li>)}
          </ul>
          <div className="mfa-recovery-actions">
            <button type="button" onClick={handleDownload}>
              <Download size={14} /> {downloaded ? 'Downloaded' : 'Download'}
            </button>
            <button type="button" className="btn-accent-outline" onClick={handleCopy}>
              {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy all</>}
            </button>
            <button type="button" className="btn-accent-outline" onClick={handleDone}>Done</button>
          </div>
        </div>
        {confirmModal}
      </>
    )
  }

  return (
    <>
      <div className="panel-title">Recovery codes</div>
      <div className="mfa-status-row">
        <div>
          <div className={`mfa-recovery-title tone-${advice.tone}`}>
            {advice.tone === 'critical' && <KeyRound size={14} style={{ verticalAlign: '-2px', marginRight: '6px' }} />}
            {advice.title}
          </div>
          <div className="danger-row-note">{advice.note}</div>
        </div>
        {twoFactorOn && !loading && (
          status
            ? <button type="button" className="btn-accent-outline" onClick={handleRegenerate} disabled={busy}>
                {busy ? 'Working...' : 'Replace codes'}
              </button>
            : <button type="button" onClick={handleGenerate} disabled={busy}>
                {busy ? 'Creating...' : 'Generate codes'}
              </button>
        )}
      </div>
      {error && <div className="account-msg account-msg-error" style={{ marginTop: '10px' }}>{error}</div>}
      {confirmModal}
    </>
  )
}
