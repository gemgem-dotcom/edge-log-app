'use client'

import { useState, useEffect } from 'react'
import { formatTime12h } from '@/lib/tradeMath'

const DAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']

function pad(n) {
  return String(n).padStart(2, '0')
}

// Starts null (renders nothing) rather than computing eagerly - same
// hydration-mismatch reasoning as MarketStatusPill: the server has no
// notion of the browser's local clock, so this fills in on mount instead.
// Ticks every second since the time line itself shows seconds - a live
// reading, not a static "page loaded at" timestamp.
export default function HeaderClock() {
  const [now, setNow] = useState(null)

  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  if (now === null) return null

  // Routed through formatTime12h (lib/tradeMath.js) rather than a second
  // copy of the 12-hour conversion, so this reads exactly like every
  // trade time already shown elsewhere in the app - built as the same
  // "HH:MM:SS" shape that function already expects.
  const hhmmss = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  const dateStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`

  return (
    <div className="header-clock">
      <div className="header-clock-time">{formatTime12h(hhmmss)}</div>
      <div className="header-clock-date">{DAY_NAMES[now.getDay()]} | {dateStr}</div>
    </div>
  )
}
