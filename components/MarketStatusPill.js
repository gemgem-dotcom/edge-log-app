'use client'

import { useState, useEffect } from 'react'
import { isMarketOpen } from '@/lib/marketHours'

// Starts null (renders nothing) rather than computing eagerly, since the
// server has no timezone-correct notion of "now" - avoids a hydration
// mismatch, then fills in on mount from the browser's clock.
export default function MarketStatusPill() {
  const [open, setOpen] = useState(null)

  useEffect(() => {
    setOpen(isMarketOpen())
    const id = setInterval(() => setOpen(isMarketOpen()), 60000)
    return () => clearInterval(id)
  }, [])

  if (open === null) return null
  return (
    <div className={`market-status-pill ${open ? 'market-status-pill-open' : 'market-status-pill-closed'}`}>
      <span className="market-status-dot" />
      {open ? 'Market open' : 'Market closed'}
    </div>
  )
}
