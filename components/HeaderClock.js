'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { offsetLabel } from '@/lib/timezone'
import { formatTime12h } from '@/lib/tradeMath'

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']

function pad(n) {
  return String(n).padStart(2, '0')
}

// Reads either the real Date's own local getters or its UTC getters off a
// pre-shifted copy - see the shift in the component below. Shares one shape
// either way so the render logic below doesn't need to care which mode
// produced it.
function partsFor(date, useUTC) {
  return {
    hours: useUTC ? date.getUTCHours() : date.getHours(),
    minutes: useUTC ? date.getUTCMinutes() : date.getMinutes(),
    seconds: useUTC ? date.getUTCSeconds() : date.getSeconds(),
    day: useUTC ? date.getUTCDate() : date.getDate(),
    month: useUTC ? date.getUTCMonth() : date.getMonth(),
    year: useUTC ? date.getUTCFullYear() : date.getFullYear(),
    weekday: useUTC ? date.getUTCDay() : date.getDay(),
  }
}

// Starts null (renders nothing) rather than computing eagerly - same
// hydration-mismatch reasoning as MarketStatusPill: the server has no
// notion of the browser's local clock, so this fills in on mount instead.
// Ticks every second since the time line itself shows seconds - a live
// reading, not a static "page loaded at" timestamp.
export default function HeaderClock() {
  const [now, setNow] = useState(null)
  // The offset a trader's account is actually configured with (Account
  // Settings' timezone picker) - null until fetched, and effectively
  // always resolves to a real value in practice, since every account that
  // can reach this shell has already passed app/app/layout.js's own
  // timezone gate. getSession() (local, no network) rather than getUser()
  // (revalidates against the auth server) - this only ever reads
  // user_metadata off whatever session already exists, and every write
  // path that touches it refreshes the local session in the same breath,
  // so there's nothing here a revalidated token would catch that a stale
  // local one wouldn't already reflect a moment later. See app/app/page.js's
  // own loadInstruments() for the fuller version of this same reasoning.
  const [offset, setOffset] = useState(null)
  // 'local' (the browser's own clock, the default) or 'offset' (the
  // trader's configured UTC offset) - toggled by clicking the clock.
  const [mode, setMode] = useState('local')

  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const tz = session?.user?.user_metadata?.timezone
      if (tz !== undefined && tz !== null) setOffset(parseFloat(tz))
    })
  }, [])

  // No configured offset to switch to (shouldn't happen past the timezone
  // gate, but this renders on every page under it) - clicking does nothing
  // rather than silently showing a meaningless UTC+0 guess.
  function handleClick() {
    if (offset === null) return
    setMode((m) => (m === 'local' ? 'offset' : 'local'))
  }

  if (now === null) return null

  const showOffset = mode === 'offset' && offset !== null
  // Date.prototype.getTime() is already UTC-epoch milliseconds regardless
  // of the browser's own timezone, so shifting by the configured offset and
  // then reading the shifted copy's UTC getters (not its local ones) gives
  // the correct wall-clock time for that offset - same technique
  // lib/timezone.js's own formatInTz uses.
  const shifted = showOffset ? new Date(now.getTime() + offset * 3600000) : now
  const { hours, minutes, seconds, day, month, year, weekday } = partsFor(shifted, showOffset)

  // Routed through formatTime12h (lib/tradeMath.js) rather than a second
  // copy of the 12-hour conversion, so this reads exactly like every
  // trade time already shown elsewhere in the app - built as the same
  // "HH:MM:SS" shape that function already expects.
  const hhmmss = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  const dateStr = `${pad(day)}/${pad(month + 1)}/${year}`
  // The offset label replaces the day name in offset mode rather than
  // sitting alongside it - confirming *which* zone is on screen matters
  // more here than the day of week, and the clock has no room to show both
  // without wrapping.
  const dayOrOffset = showOffset ? offsetLabel(offset) : DAY_NAMES[weekday]

  return (
    <div
      className="header-clock"
      onClick={handleClick}
      title={offset === null ? undefined : (showOffset ? 'Click to show your local time' : 'Click to show your set timezone')}
    >
      {/* key replays the fade below on every mode switch - same
          key+.stats-refreshable technique OverviewDashboard.js's stat
          grids use to mark a value as having just changed, reusing that
          rule's own stat-value-in keyframe rather than a second copy of
          it. */}
      <div className="header-clock-fade" key={mode}>
        <div className="header-clock-time">{formatTime12h(hhmmss)}</div>
        <div className="header-clock-date">{dayOrOffset} | {dateStr}</div>
      </div>
    </div>
  )
}
