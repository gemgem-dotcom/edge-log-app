'use client'

import { useState } from 'react'
import { Sun, Moon } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { toast } from '@/lib/toast'
import { UTC_OFFSETS, offsetLabel } from '@/lib/timezone'

// Timezone is owned by the page rather than here, because the sign-in
// history renders its timestamps in it and has to re-render on a change.
export default function PreferencesSection({ initialTheme, timezone, onTimezoneChange }) {
  const [theme, setTheme] = useState(initialTheme)
  const [shiftingTz, setShiftingTz] = useState(false)

  function handleThemeChange(newTheme) {
    setTheme(newTheme)
    localStorage.setItem('edgelog-theme', newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
  }

  // Every trade's stored trade_date/trade_time/exit_time is physically
  // shifted to match, not just relabeled - see shift_trade_times in
  // schema.sql for why (and why exit_time shifts as a bare time-of-day
  // rather than following the date). That's a real, hard-to-undo rewrite
  // of the trader's whole history, so it's confirmed like the other
  // irreversible actions in this app (delete trade, sign out everywhere).
  async function handleTimezoneChange(newTz) {
    const deltaHours = parseFloat(newTz) - parseFloat(timezone)
    if (deltaHours !== 0) {
      const sure = confirm(
        `Change your timezone to ${offsetLabel(newTz)}? Every trade time you've logged will shift by ` +
        `${deltaHours > 0 ? '+' : ''}${deltaHours} hour${Math.abs(deltaHours) === 1 ? '' : 's'} to match - this rewrites your ` +
        `trade history and can't be undone by switching back.`
      )
      if (!sure) return
    }

    setShiftingTz(true)
    if (deltaHours !== 0) {
      const { error: shiftError } = await supabase.rpc('shift_trade_times', { delta_hours: deltaHours })
      if (shiftError) {
        setShiftingTz(false)
        toast.error(`Couldn't update your trade times — ${shiftError.message}`)
        return
      }
    }

    onTimezoneChange(newTz)
    const { error } = await supabase.auth.updateUser({ data: { timezone: newTz } })
    setShiftingTz(false)
    if (!error) toast.success('Timezone updated — trade times shifted to match.')
    else toast.error(`Trade times were updated, but saving the new timezone failed — ${error.message}`)
  }

  return (
    <>
      <div className="section-heading" style={{ marginTop: '8px' }}>General</div>
      <div className="panel">
        <div className="field wide">
          <label>Theme</label>
          <div className="dir-toggle">
            <div className={`dir-btn ${theme === 'dark' ? 'active-theme' : ''}`} onClick={() => handleThemeChange('dark')}>
              <Moon size={13} style={{ marginRight: '6px', verticalAlign: '-2px' }} />Dark
            </div>
            <div className={`dir-btn ${theme === 'light' ? 'active-theme' : ''}`} onClick={() => handleThemeChange('light')}>
              <Sun size={13} style={{ marginRight: '6px', verticalAlign: '-2px' }} />Light
            </div>
          </div>
        </div>
        <div className="field wide" style={{ marginTop: '14px' }}>
          <label>Timezone</label>
          <select value={timezone} disabled={shiftingTz} onChange={(e) => handleTimezoneChange(e.target.value)}>
            {UTC_OFFSETS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <p className="account-fine-print">
          Set this to the UTC offset your trade times are logged in. Changing it shifts every trade
          time you&apos;ve already logged to match the new offset.
        </p>
      </div>
    </>
  )
}
