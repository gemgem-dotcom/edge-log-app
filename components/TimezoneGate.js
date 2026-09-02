'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { UTC_OFFSETS, browserOffsetGuess } from '@/lib/timezone'

// Blocks the whole logged-in app (see app/app/layout.js) until the account
// has an explicit timezone saved - trade_date/trade_time are logged as
// plain wall-clock values with no timezone of their own (see schema.sql's
// comment on shift_trade_times), and lib/tradeSessions.js needs a real
// offset to convert them to ET accurately. Pre-selects the browser's own
// current offset so accepting the default is one click, but still requires
// an explicit submit rather than silently saving that guess unconfirmed -
// same as the name/instrument onboarding steps in app/app/page.js, which
// also require a submit instead of quietly defaulting values behind the
// scenes.
export default function TimezoneGate({ onSet }) {
  const [timezone, setTimezone] = useState(browserOffsetGuess())
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    await supabase.auth.updateUser({ data: { timezone } })
    setSaving(false)
    onSet(timezone)
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="title">Edge<span style={{ fontWeight: 400 }}>Log</span></div>
        <h1>Set your timezone</h1>
        <p className="onboard-note">
          Choose the timezone you’ll use to log your trades. EdgeLog uses this information
          to record trade data correctly. You can change this anytime in Account Settings.
        </p>
        <form onSubmit={handleSubmit}>
          <div className="field full">
            <label>Timezone</label>
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)} required>
              {UTC_OFFSETS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <button type="submit" disabled={saving} className="auth-submit">
            {saving ? 'Saving…' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  )
}
