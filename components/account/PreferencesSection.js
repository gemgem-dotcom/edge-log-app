'use client'

import { useState } from 'react'
import { Sun, Moon } from 'lucide-react'
import { supabase } from '@/lib/supabaseClient'
import { toast } from '@/lib/toast'
import { UTC_OFFSETS } from '@/lib/timezone'

// Timezone is owned by the page rather than here, because the sign-in
// history renders its timestamps in it and has to re-render on a change.
export default function PreferencesSection({ initialTheme, timezone, onTimezoneChange }) {
  const [theme, setTheme] = useState(initialTheme)

  function handleThemeChange(newTheme) {
    setTheme(newTheme)
    localStorage.setItem('edgelog-theme', newTheme)
    document.documentElement.setAttribute('data-theme', newTheme)
  }

  async function handleTimezoneChange(newTz) {
    onTimezoneChange(newTz)
    const { error } = await supabase.auth.updateUser({ data: { timezone: newTz } })
    if (!error) toast.success('Timezone updated.')
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
          <select value={timezone} onChange={(e) => handleTimezoneChange(e.target.value)}>
            {UTC_OFFSETS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <p className="account-fine-print">
          Set this to the UTC offset your trade times are logged in.
        </p>
      </div>
    </>
  )
}
